import {
  useCanvasAccess,
  useCanvasCommands,
  useCanvasInteraction,
  useHasEntities,
} from "#context/use-canvas.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { addFilesToCanvas } from "#application/canvas/entity-placement.ts";
import { showMediaLoadFailureToasts } from "#application/canvas/media-load-notifications.ts";
import { MediaImagePlus, Xmark } from "iconoir-react";
import { useEffect, useRef, useState } from "react";
import { config } from "#config";
import { Button } from "./ui/button";
import { Drawer } from "#ui/drawer/index.tsx";
import { useHostedWorkspaceRuntime } from "#context/use-hosted-workspace-runtime.ts";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceAssetSummary, WorkspaceAssetUsage } from "@voidmesh/api-contract";
import { WorkspaceRole } from "@voidmesh/domain";
import { mapSettledWithConcurrency } from "#lib/async-concurrency.ts";
import "./media-library.css";

const MAX_CONCURRENT_ASSET_DOWNLOADS = 4;

interface AddingProgress {
  completed: number;
  phase: "loading" | "preparing";
  total: number;
}

export function UploadControls() {
  const access = useCanvasAccess();
  const hasEntities = useHasEntities();
  if (!access.canEdit) {
    return (
      <div className="mobile-common-knobs pb-1">
        <div className="mobile-row no-selection-message">
          <p>Viewer access · editing is disabled</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mobile-common-knobs pb-1">
      <div className="mobile-row">
        <FileUploadComponent />
      </div>
      {!hasEntities && (
        <div className="mobile-row no-selection-message">
          <p>Add images, videos or GIFs for editing</p>
        </div>
      )}
    </div>
  );
}

type HostedRuntime = NonNullable<ReturnType<typeof useHostedWorkspaceRuntime>>;

export function FileUploadComponent() {
  const access = useCanvasAccess();
  const hosted = useHostedWorkspaceRuntime();
  if (!access.canEdit) return null;
  return hosted ? <HostedFileUploadComponent hosted={hosted} /> : <LocalFileUploadComponent />;
}

function LocalFileUploadComponent() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { addEntity } = useCanvasCommands();
  const interaction = useCanvasInteraction();
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  const handleFileSelect = async (files: FileList | readonly File[] | null) => {
    if (!files || files.length === 0) return;
    const container = document.querySelector(".infinite-canvas");
    if (!(container instanceof HTMLElement)) return;
    const anchor = interaction.getViewportCenter(
      container.getBoundingClientRect(),
      window.devicePixelRatio,
    );
    await addFilesToCanvas(Array.from(files), addEntity, container, {
      anchor,
      bottomInset,
      fitToView: true,
      onLoadFailure: showMediaLoadFailureToasts,
      select: true,
    });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={[...config.supports.image, ...config.supports.video].join(",")}
        onChange={(event) => void handleFileSelect(event.target.files)}
        hidden
        multiple
      />
      <Button variant="primary" onClick={() => inputRef.current?.click()}>
        <MediaImagePlus />
        <span>Add Images/Videos</span>
      </Button>
    </>
  );
}

function HostedFileUploadComponent({ hosted }: { hosted: HostedRuntime }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { addEntity } = useCanvasCommands();
  const interaction = useCanvasInteraction();
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [usage, setUsage] = useState<WorkspaceAssetUsage | "all">("all");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [addingProgress, setAddingProgress] = useState<AddingProgress | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [canvasPreviewUrls, setCanvasPreviewUrls] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const queryClient = useQueryClient();

  const assetQuery = useInfiniteQuery({
    enabled: libraryOpen,
    initialPageParam: undefined as string | undefined,
    queryKey: ["workspace-assets", hosted.workspace.id],
    queryFn: ({ pageParam }) =>
      hosted.api.listAssets(hosted.workspace.id, { cursor: pageParam, usage: "all" }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    const root = scrollRef.current;
    if (!node || !root || !libraryOpen || !assetQuery.hasNextPage) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !assetQuery.isFetchingNextPage) {
          void assetQuery.fetchNextPage();
        }
      },
      { root, rootMargin: "0px 0px 320px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [assetQuery, libraryOpen]);

  useEffect(() => {
    if (!libraryOpen) return;
    let disposed = false;
    const urls: string[] = [];
    const loadPreviews = async () => {
      const missingThumbnailIds = new Set(
        assetQuery.data?.pages.flatMap((page) =>
          page.assets.filter((asset) => asset.thumbnailUrl === null).map((asset) => asset.id),
        ) ?? [],
      );
      await hosted.backfillCanvasAssetThumbnails(missingThumbnailIds);
      const previews = await hosted.getCanvasVideoPreviews();
      if (disposed) return;
      const next = new Map<string, string>();
      for (const [assetId, preview] of previews) {
        const url = URL.createObjectURL(preview);
        urls.push(url);
        next.set(assetId, url);
      }
      setCanvasPreviewUrls(next);
    };
    void loadPreviews();
    return () => {
      disposed = true;
      for (const url of urls) URL.revokeObjectURL(url);
      setCanvasPreviewUrls(new Map());
    };
  }, [assetQuery.data, hosted, libraryOpen]);

  const handleFileSelect = async (
    files: FileList | readonly File[] | null,
    onLoadProgress?: (completed: number, total: number) => void,
  ) => {
    if (!files || files.length === 0) return;

    const container = document.querySelector(".infinite-canvas");
    if (!(container instanceof HTMLElement)) return;

    const anchor = interaction.getViewportCenter(
      container.getBoundingClientRect(),
      window.devicePixelRatio,
    );

    await addFilesToCanvas(Array.from(files), addEntity, container, {
      anchor,
      select: true,
      fitToView: true,
      bottomInset,
      onLoadFailure: showMediaLoadFailureToasts,
      onLoadProgress,
    });
    setLibraryOpen(false);
  };

  const canvasAssetIds = hosted.getCanvasAssetIds();
  const allAssets =
    assetQuery.data?.pages.flatMap((page) =>
      page.assets.map((asset) =>
        canvasAssetIds.has(asset.id) ? { ...asset, usage: "active" as const } : asset,
      ),
    ) ?? [];
  const assets = allAssets.filter((asset) => usage === "all" || asset.usage === usage);
  const selectedAssets = assets.filter((asset) => selectedIds.has(asset.id));
  const canDeleteSelection =
    hosted.workspace.role === WorkspaceRole.owner &&
    selectedAssets.length > 0 &&
    selectedAssets.every((asset) => asset.usage === "unused");
  const deleteMutation = useMutation({
    mutationFn: async (deleting: readonly WorkspaceAssetSummary[]) => {
      await Promise.all(
        deleting.map((asset) => hosted.api.deleteAsset(hosted.workspace.id, asset.id)),
      );
    },
    onSuccess: async () => {
      setSelectedIds(new Set());
      setConfirmingDelete(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-assets", hosted.workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ["workspace", hosted.workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ["account"] }),
      ]);
    },
    onError: (error) => setActionError(error.message),
  });

  const addSelectedAssets = async () => {
    if (selectedAssets.length === 0) return;
    setAdding(true);
    setActionError(null);
    try {
      let completed = 0;
      setAddingProgress({ completed, phase: "loading", total: selectedAssets.length });
      const results = await mapSettledWithConcurrency(
        selectedAssets,
        MAX_CONCURRENT_ASSET_DOWNLOADS,
        async (asset) => {
          try {
            return await hosted.loadAsset(asset);
          } finally {
            completed++;
            setAddingProgress({ completed, phase: "loading", total: selectedAssets.length });
          }
        },
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        const firstReason = failed[0]!.reason;
        throw firstReason instanceof Error
          ? firstReason
          : new Error(`${failed.length} stored media items could not be loaded`);
      }
      const files = results.map((result) => {
        if (result.status !== "fulfilled") throw new Error("Stored media could not be loaded");
        return result.value;
      });
      setAddingProgress({ completed: 0, phase: "preparing", total: files.length });
      await handleFileSelect(files, (prepared, total) => {
        setAddingProgress({ completed: prepared, phase: "preparing", total });
      });
      setSelectedIds(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Stored media could not be added");
    } finally {
      setAdding(false);
      setAddingProgress(null);
    }
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={[...config.supports.image, ...config.supports.video].join(",")}
      onChange={(event) => {
        void handleFileSelect(event.target.files);
        event.currentTarget.value = "";
      }}
      hidden
      multiple
    />
  );

  const groups = groupAssetsByDate(assets);

  return (
    <>
      {fileInput}
      <Drawer.Root
        open={libraryOpen}
        onOpenChange={(open) => {
          setLibraryOpen(open);
          if (!open) {
            setSelectedIds(new Set());
            setConfirmingDelete(false);
            setActionError(null);
          }
        }}
      >
        <Drawer.Trigger
          render={(props) => (
            <Button {...props} variant="primary">
              <MediaImagePlus aria-hidden="true" />
              <span>Add Images/Videos</span>
            </Button>
          )}
        />
        <Drawer.Popup className="media-library-drawer">
          <Drawer.Title>Media Library</Drawer.Title>
          <Button
            variant="secondary"
            className="media-library-close"
            aria-label="Close media library"
            onClick={() => setLibraryOpen(false)}
          >
            <Xmark aria-hidden="true" />
          </Button>
          <Drawer.Content className="media-library-content">
            <header className="media-library-header">
              <fieldset className="media-library-filters" aria-label="Filter media">
                {(["all", "active", "unused"] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={usage === filter}
                    onClick={() => {
                      setUsage(filter);
                      setSelectedIds(new Set());
                      if (scrollRef.current) scrollRef.current.scrollTop = 0;
                    }}
                  >
                    {filter === "all" ? "All" : filter === "active" ? "On Canvas" : "Unused"}
                  </button>
                ))}
              </fieldset>
              <Button
                className="media-library-upload"
                variant="primary"
                aria-label="Upload Media"
                onClick={() => inputRef.current?.click()}
              >
                <MediaImagePlus aria-hidden="true" />
                <span className="media-library-upload-label">Upload</span>
              </Button>
            </header>

            <div className="media-library-scroll" ref={scrollRef} aria-live="polite">
              {actionError && (
                <p className="media-library-inline-error" role="alert">
                  {actionError}
                </p>
              )}
              {assetQuery.isPending ? (
                <div className="media-library-state">
                  <p>Loading…</p>
                </div>
              ) : assetQuery.isError ? (
                <div className="media-library-state media-library-error" role="alert">
                  <strong>Couldn’t Load Media</strong>
                  <p>{assetQuery.error.message}</p>
                  <Button variant="secondary" onClick={() => void assetQuery.refetch()}>
                    Try Again
                  </Button>
                </div>
              ) : assets.length === 0 ? (
                <div className="media-library-empty">
                  <span className="media-library-empty-icon" aria-hidden="true">
                    <MediaImagePlus />
                  </span>
                  <strong>{allAssets.length === 0 ? "No Media Yet" : "No Matches"}</strong>
                  {allAssets.length === 0 && (
                    <Button variant="primary" onClick={() => inputRef.current?.click()}>
                      <MediaImagePlus aria-hidden="true" />
                      <span>Upload Media</span>
                    </Button>
                  )}
                </div>
              ) : (
                groups.map(([label, datedAssets]) => (
                  <section className="media-library-date-group" key={label}>
                    <h3>{label}</h3>
                    <div className="media-library-grid">
                      {datedAssets.map((asset) => (
                        <AssetCard
                          asset={asset}
                          key={asset.id}
                          thumbnailUrl={canvasPreviewUrls.get(asset.id) ?? asset.thumbnailUrl}
                          selected={selectedIds.has(asset.id)}
                          onToggle={() => {
                            const next = new Set(selectedIds);
                            if (next.has(asset.id)) next.delete(asset.id);
                            else next.add(asset.id);
                            setSelectedIds(next);
                            setConfirmingDelete(false);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}
              <div className="media-library-sentinel" ref={sentinelRef} />
              {assetQuery.isFetchingNextPage && (
                <p className="media-library-status">Loading more…</p>
              )}
            </div>
          </Drawer.Content>
          {selectedAssets.length > 0 && (
            <footer className="media-library-selection-bar">
              <span>{selectedAssets.length} selected</span>
              <div className="media-library-selection-actions">
                {canDeleteSelection && (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (confirmingDelete) {
                        setActionError(null);
                        deleteMutation.mutate(selectedAssets);
                      } else setConfirmingDelete(true);
                    }}
                    isPending={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending
                      ? "Deleting…"
                      : confirmingDelete
                        ? `Delete ${selectedAssets.length} permanently`
                        : "Delete"}
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => void addSelectedAssets()}
                  isPending={adding}
                >
                  {adding && addingProgress
                    ? `${addingProgress.phase === "loading" ? "Loading" : "Preparing"} ${addingProgress.completed}/${addingProgress.total}…`
                    : adding
                      ? "Adding…"
                      : `Add ${selectedAssets.length} to canvas`}
                </Button>
              </div>
            </footer>
          )}
        </Drawer.Popup>
      </Drawer.Root>
    </>
  );
}

function AssetCard({
  asset,
  onToggle,
  selected,
  thumbnailUrl,
}: {
  asset: WorkspaceAssetSummary;
  onToggle(): void;
  selected: boolean;
  thumbnailUrl: string | null;
}) {
  return (
    <button className="media-library-card" type="button" aria-pressed={selected} onClick={onToggle}>
      <span className="media-library-thumbnail">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" width="320" height="320" loading="lazy" decoding="async" />
        ) : (
          <MediaImagePlus aria-hidden="true" />
        )}
        <span className="media-library-usage">
          {asset.usage === "active" ? "On Canvas" : "Unused"}
        </span>
      </span>
      <span className="media-library-card-name" title={asset.originalFilename}>
        {asset.originalFilename}
      </span>
      <span className="media-library-card-meta">{formatBytes(asset.byteLength)}</span>
    </button>
  );
}

function groupAssetsByDate(
  assets: readonly WorkspaceAssetSummary[],
): [string, WorkspaceAssetSummary[]][] {
  const groups = new Map<string, WorkspaceAssetSummary[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  for (const asset of assets) {
    const date = new Date(asset.createdAt);
    const label = sameDay(date, today)
      ? "Today"
      : sameDay(date, yesterday)
        ? "Yesterday"
        : MONTH_YEAR_FORMAT.format(date);
    const group = groups.get(label) ?? [];
    group.push(asset);
    groups.set(label, group);
  }
  return [...groups];
}

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${NUMBER_FORMAT.format(bytes)} B`;
  if (bytes < 1024 ** 2) return `${NUMBER_FORMAT.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${NUMBER_FORMAT.format(bytes / 1024 ** 2)} MB`;
  return `${NUMBER_FORMAT.format(bytes / 1024 ** 3)} GB`;
}

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
