# Overlap performance

## Diagnosis

The action-layer toggle bottleneck was GPU work, not React updates. In the
pre-edit dense trace, return frames 60–65 took 56–63 ms end to end. CPU rendering
took 0.6–1.0 ms; GPU completion waits took 55–63 ms.

Every fragment scanned the scene-wide contact array for material effects, then
scanned it again for slice alpha. Unrelated cards paid for those scans too.
Selected cards submitted a full-card draw for every covering partner, including
zero-weight slices at transition endpoints and throughout the decay tail.

## Changes

- Build an exact per-card adjacency index in the existing GPU buffer. Resolve
  ranges in the vertex shader; fragments traverse only their own contacts.
- Reuse that index for CPU slice planning instead of scanning every crossing
  pair for every visible card.
- Bound passage over each expanded, rotated card and omit provably empty
  slices. Full-weight slices use the unsplit path. Bounds include the selection
  border, packed geometry error, and the ripple amplitude.
- Compute the per-pixel partition once, before material shading. Zero-weight
  pixels skip field evaluation and texture samples.
- Use explicit base-level sampling for single-mip composition textures. Remove
  disabled derivative-uniformity diagnostics and validate external-video sample
  rewriting, including minified production shaders.
- Select the winning contact before evaluating its detailed flow and traveling
  front. Preserve original contact order and tie breaking.
- When RGB displacement is exactly zero, sample once rather than sampling the
  same coordinates three times. Keep wake displacement and the original
  premultiplied reconstruction, including very small source alpha.

Original stack order, source-alpha compositing, external-video sampling,
foreground sharpness after blur, effect strength, and decay remain intact.
Exceeding the GPU binding limit raises an explicit error before replacing the
previous allocation; no contacts are silently capped.

## Measurement

Measured 2026-09-15 on an Apple M1 Pro with Headless Chrome 153, a 1280×720 canvas
at DPR 1, RAF pacing, and GPU completion waits after each frame. The primary
metric is `endToEndP95Ms`, which includes browser/queue completion overhead,
not a pure GPU timestamp duration.

The branch baseline is commit `4b65cd8` with the user's existing `rgbStrength:
1.5` edit preserved. Baselines contain one round of three samples; final
candidate records contain three rounds of three samples. These are Mac
measurements, not iPhone 15 Pro results.

The dense baseline P95 was 64.6 ms. Indexed contacts alone reduced it to 15.0 ms;
adding slice rejection measured 11.9 ms in the single-round iteration. The
repeated final dense measurement was 13.6 ms, about 79% below baseline. P95 RAF
interval fell from 66.7 ms to 16.8 ms. Individual final rounds measured 13.5,
13.6, and 14.0 ms P95.

The mixed-media guard's median P95 improved from 11.0 to 7.7 ms, about 30%.
Final rounds measured 7.7, 11.4, and 7.7 ms, so the improvement was not uniform
across every round. Source texture/upload counts and reported peak residency
stayed unchanged. Mixed P95 CPU render time was 1.9 ms before and 2.2 ms after;
the added indexing/bounds work trades a little CPU time for less GPU work.

The 72 source textures, 72 initial uploads, and 77,939,464-byte reported peak
texture residency stayed unchanged. Measured samples had no source allocations,
uploads, or evictions. Completion time changes the number of intermediate frames
because transitions advance by real elapsed time; compare individual transition
frames as well as whole-run counters. At exact endpoints, a selected card under
eleven covers now needs one material slice instead of twelve.

An existing `main` A/B guard, `multi-72-unique-cached-composition`, passed the
CPU encode regression threshold. CPU encode averaged 0.026 ms on `main` and
0.034 ms on the candidate, an 0.008 ms difference below the 0.1 ms threshold.
This guards ordinary composition, not overlap semantics.

## Main comparison and the 120 fps budget

The target is 8.33 ms per frame. The dense stress case still misses it.
Headless RAF in these records runs at 60 Hz; a 16.7 ms RAF interval does not
establish 120 fps capability. End-to-end P95 remains the budget check here.

For the overlap scenarios, `main` does not contain the feature or its benchmark
definitions. A detached `main` worktree at `40abe15645c3` received only the same
benchmark workload/instrumentation, excluding the branch-only FancyEffects
import/property. No main renderer changes were made. Both refs received identical
media, geometry, selection, offsets, blur inputs, and pacing. This measures the
cost of adding overlap; it is not a visually equivalent feature comparison.
The temporary worktree was removed after measurement.

| Scenario                                   | Main P95 | Indexed/pruned branch P95 | Added time |
| ------------------------------------------ | -------: | ------------------------: | ---------: |
| 72 images, six 12-card stacks              |   4.8 ms |                   12.2 ms |     7.4 ms |
| 12 images and four playing external videos |   6.3 ms |                    9.3 ms |     3.0 ms |

Each measurement above contains three rounds of three samples. Both comparisons
fail the 10% relative regression threshold. That is expected when adding a
GPU effect, but it must not be reported as a passing performance result.
Dense P95 CPU time was 0.5 ms on main versus 1.0 ms on the branch. Matching
return frames 60–62 took 2.7/3.0/4.1 ms on main and 6.2/12.3/10.7 ms on the
branch, with only 0.3 ms and 0.7/0.7/1.1 ms of CPU work respectively.
The added cost is predominantly GPU/completion work.

The previous exact-math candidate measured 12.1 ms dense P95 over three rounds.
This is about 81% below the pre-edit branch baseline, but still 3.77 ms above
the 120 fps budget. Texture residency, initial source uploads, and source
texture counts remain unchanged. The final mixed candidate measured 7.3 ms P95
with a 12.1 ms maximum. Final comparisons to the same-workload main records are
4.8 → 12.1 ms dense and 6.3 → 7.3 ms mixed. Both still fail the 10% relative
regression threshold. The main runs precede final candidate runs by about
16 minutes; these are same-machine comparisons, not interleaved runs.

Single-round experiments were measured separately and removed when they did not
help: a CPU-prepared contact buffer measured 12.2 ms, conservative tight slice
quads 13.1 ms, flat vertex-prepared single-contact constants 11.5 ms, and a
sub-millionth-pixel wake-tail cutoff 11.6 ms. The preceding zero-RGB candidate
measured 11.6 ms. These small timing differences are within observed variation;
none establishes a new large optimization. No quality cutoff or tight geometry
remains in the renderer.

## Opaque occlusion and always-sharp active material

The latest pass adds an exact GPU opacity proof per immutable uploaded still-image
texture. Proofs are staged during source upload, cached by texture identity, and
byte-budgeted. Processed textures, GIF/SVG frames, and external videos are not
classified as immutable opaque sources. No CPU readback or guessed file-type
opacity is used. Renderer initialization awaits asynchronous compilation of
crossing render and opacity compute pipelines rather than paying for first use
during a return transition.

Dense original-image stacks use one instanced depth prepass. Cached proof flags
are copied into a compact GPU table, so the depth pass does not bind or draw
each distinct image texture. The color passes still preserve scene order.
Active/lifted and selected material bypasses occlusion. Proven opaque coverage
is inset by a conservative bound on warped base-alpha UVs; RGB channel offsets
do not determine opacity. Thin warped rims and transparent holes stay visible.
Sparse scenes avoid the prepass's extra work.

Active cards no longer enter scene blur, even in their lower crossing slices.
After blurring the non-active scene, composition snapshots the backdrop and
reconstructs lower active slices with sharp material. Covers use the backdrop's
RGB and their original warped alpha. Final active foreground slices remain
sharp as before. Reconstruction is omitted when active material is completely
on the foreground plane. Proven opaque cover interiors skip material work when
only their alpha is needed.

The earlier repeated dense P95 was 9.6 ms, with rounds at 9.2/9.6/10.4 ms,
CPU P95 0.7 ms, and a 13.5 ms maximum. This is 21% below the previous 12.1 ms
candidate and 85% below the original 64.6 ms branch baseline. It still misses
the 8.33 ms budget by 1.27 ms. The same-workload main measurement is 4.8 ms
and lacks the overlap effect; the branch still costs twice as much end to end.
These records are same-machine, not interleaved or on-device iPhone results.

The earlier repeated mixed guard measured 8.0 ms P95, with rounds at 7.8/8.0/8.0 ms,
CPU P95 1.8 ms, and a 12.2 ms maximum. Sharp reconstruction adds 0.7 ms to the
previous 7.3 ms mixed P95. This workload remains below 8.33 ms at P95, but not
at its maximum, and the same-workload main value is 6.3 ms. The guard retains
12 original source textures and 12 initial uploads, with four playing videos
remaining external. Sampled frames have zero new uploads, allocations, scans,
or evictions. The sparse mixed scene uses no depth prepass. Its backdrop target
adds 7,340,832 bytes, bringing reported peak texture residency to 18,163,240 bytes.

A later verification after cleanup/resize guards and complete benchmark counters
measured 11.9 ms dense P95, with rounds at 11.7/11.9/12.4 ms, CPU P95 1.6 ms,
and a 19.2 ms maximum. Mixed P95 measured 12.2 ms, with rounds at
12.3/10.8/12.2 ms, CPU P95 2.5 ms, and a 31.2 ms maximum. These are the records
referenced by `latest.json`. Both workloads miss 8.33 ms in this verification.
The retained earlier repeats show variation rather than a stable 120 fps result.
Do not report only the faster repeat or claim a stable 21% occlusion improvement.

Latest dense return frames 60/61/62 measured 8.9/14.1/12.1 ms, with CPU work
at 3.3/2.8/1.0 ms. Setup, prepare, and encode phases all grew compared with the
earlier 0.5/0.7/0.7 ms CPU frames. Texture counts, uploads, proof-scan deltas,
and layer bytes stayed the same. A read-only host snapshot also showed
substantial unrelated CPU/background browser activity. Host contention is a
possible contributor, not a proven explanation for all timing differences.
The earlier main measurements are not interleaved with this later verification;
4.8/6.3 ms main versus 11.9/12.2 ms branch is a same-machine comparison, not a
clean isolation of incremental effect cost under identical host load.

The final ordinary `main` A/B guard passed over three rounds per side:
`multi-72-unique-cached-composition` CPU encode measured 0.027 ms/frame on both
main and the current tree. This guards ordinary batching, not overlap semantics.

Raw return frames 60/61/62 in final round 0 measured 4.6/9.5/6.2 ms with
0.5/0.7/0.7 ms CPU work. In round 1 they measured 4.6/9.5/11.5 ms. GPU/browser
completion remains the dominant cost, and individual transitions still exceed
the 120 fps budget. An early lazy-pipeline iteration had a 50.9 ms first-return
completion spike; the repeated precompiled final maximum is 13.5 ms.

All final dense samples retain 72 source textures and 72 initial uploads, with
zero sampled-frame allocations, uploads, opacity scans, or evictions. Reported
peak texture residency increases from 77,939,464 to 88,950,712 bytes because
the depth and backdrop targets use 11,011,248 additional bytes. Texture totals
include these new composition targets but retain the harness's existing scope
for legacy renderer resources; they are not a driver-wide memory measurement.
Opacity-buffer statistics include conservative allocation charges, not only
four-byte payload sizes.

Single-round controls measured 13.2 ms with sharp reconstruction but occlusion
disabled, 9.7 ms with precompiled per-texture occlusion, and 9.1 ms after batching
the depth pass. These are orientation, not independent statistical guarantees.
Front-to-back prepass ordering measured 12.0 ms and was removed. An exact
interior attenuation shortcut measured 9.5 ms versus 9.7 ms and was removed as
inconclusive. CPU-prepared passing energy reused a spare contact slot but measured
10.4 ms versus 9.1 ms, so it was also removed. No pulse approximation remains.

## Visual evaluation

The retained changes do not shorten transitions, reduce effect strength, lower
texture resolution, cap contacts, or approximate the wake. The user's
`rgbStrength: 1.5` edit is preserved. The gradual depth reveal remains; active
detail is now sharp throughout instead of emerging from a gray blur. Through
translucent covers, active detail stays sharp under the blurred backdrop's tint.
This compositing change is intentional, not pixel equivalence with the old
active-under-blur rendering. Check bright images for the disappearing blur flash
and transparent edges for halos or a sudden depth pop.

Evaluate rapid on/off reversals on rotated stacks. Look for a depth jump,
selection-border clipping, a hard seam through transparent media, or a pop as
the RGB tail finishes while the wake continues. Empty-slice rejection must not
remove a card that remains visible through a transparent partner.

The GPU visual guard in `bench/overlap-visual-guard.ts` compares the exact-zero
fast paths against full material calculations on 12 rotated cards with holes,
feathered rims, and near-zero alpha. It covers 17 timeline positions in both
directions and all/scene/action composition layers. Run it separately from
timing via `import('/bench/render-bench.ts').then(m => m.validateOverlapFastPaths())`
on the development benchmark page; it fails explicitly if validation errors occur or channel
differences exceed one RGBA8 quantization step.
The latest measured result was 51 comparisons with three changed channels, each differing
by one quantization step, across more than 40 million compared channels. No GPU
validation errors occurred. This guards the fast paths, not a claim of complete
visual equivalence with main, which lacks the overlap effect. Half the fixtures
are fully opaque and half have transparent holes and feathered rims. A
zero/nonzero WebGPU occlusion-query witness verifies rejection of a hidden
opaque pixel instead of assuming precise sample counters are available.
Eleven lift/return checks retain high-frequency active detail both outside and
under a translucent cover. They isolate reconstruction over a constant blurred
backdrop; the mixed-media timing guard exercises full renderer blur orchestration.

Raw records are retained locally under:

- [dense baseline](./results/overlap-baseline/latest.json)
- [dense candidate](./results/overlap-candidate/latest.json)
- [mixed baseline](./results/overlap-mixed-baseline/latest.json)
- [mixed candidate](./results/overlap-mixed-candidate/latest.json)
- [same-workload main, dense](./results/main-overlap-ab/dense/main/latest.json)
- [same-workload branch, dense](./results/main-overlap-ab/dense/branch/latest.json)
- [same-workload main, mixed](./results/main-overlap-ab/mixed/main/latest.json)
- [same-workload branch, mixed](./results/main-overlap-ab/mixed/branch/latest.json)
- [final exact-math dense candidate](./results/overlap-final-120fps/dense/latest.json)
- [final exact-math mixed candidate](./results/overlap-final-120fps/mixed/latest.json)
- [latest sharp/occlusion dense candidate](./results/overlap-sharp-final/dense/latest.json)
- [latest sharp/occlusion mixed candidate](./results/overlap-sharp-final/mixed/latest.json)
- [latest ordinary main A/B guard](./results/overlap-sharp-final/main-guard/candidate/latest.json)

## Scaling

For action-layer toggles, let `n` be scene entities, `s` selected entities, `c`
uploaded contacts, `k` the allocated entity-key high-water mark, and `d` surviving
draw items including slices.

| Work                                        | Complexity                                                 |
| ------------------------------------------- | ---------------------------------------------------------- |
| Update rendered poses                       | O(n)                                                       |
| Discover contacts during a transition       | O(s × n), worst-case O(n²)                                 |
| Refresh contacts and build/upload adjacency | O(c + k)                                                   |
| Enumerate visible slices                    | O(visible entities + their contacts)                       |
| Sort surviving slice draws                  | O(d log d)                                                 |
| Prove immutable texture opacity             | O(source texels), once per admitted texture unless evicted |
| Assemble opacity table and depth instances  | O(visible original-image entities)                         |
| Fragment material and partition work        | O(drawn pixels × contacts on that card)                    |

After the transition, discovery stops while geometry and decay continue to
update. In an ordinary sparse canvas with a small selection, the CPU work is
roughly linear and fragment contact lists stay short. More unrelated entities
no longer lengthen a card's fragment loops.

Occlusion improves the number of expensive visible pixels, not the dense
worst-case asymptotic bound. Fully transparent stacks cannot be culled as opaque.
The depth prepass is one draw with O(n) instances; additional layer targets take
O(viewport pixels) memory, and opacity proofs use a byte-budgeted texture cache.

There is no guaranteed linear dense-stack bound. Contacts and potential slices
can both be quadratic. If O(n²) full-card slices survive and every card has O(n)
contacts, fragment work has a cubic upper bound for fixed card pixel area.
Pruning improves actual work without changing that worst-case guarantee.

Drag-under has separate motion-contact discovery and currently searches active
motion contacts linearly when matching mover/cover pairs. The toggle complexity
above does not claim an O(1) motion-contact lookup.

The next device check should replay both toggle scenarios on the iPhone with
its actual DPR and canvas size. Inspect thermal state, RAF cadence, and Safari
GPU captures; do not translate the Mac timings into a phone FPS promise.

## References

Apple's [GPU optimization guidance](https://developer.apple.com/videos/play/wwdc2020/10632/)
covers overdraw and Apple GPU shader costs. The [WGSL sampling specification](https://gpuweb.github.io/gpuweb/wgsl/#texturesamplelevel)
defines explicit-level sampling that remains valid in non-uniform control flow.
