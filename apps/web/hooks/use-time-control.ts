import { useCanvasCommands, useSelectedEntities } from "#context/use-canvas.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { useParamValue } from "./use-param-value.ts";

const SKIP_UNDO = { skipUndo: true } as const;
const TIME_EPSILON = 0.0001;

function getTimeSourceEntity(entities: ShaderCanvasEntity[]): ShaderCanvasEntity | null {
  return (
    entities.find((entity) => entity.shaderParams.timeAutoPlay !== false) ?? entities[0] ?? null
  );
}

function areTimesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIME_EPSILON;
}

export function useTimeControl() {
  const { updateSelectedEntityParams, setSelectedEntityTimeAutoPlay, syncSelectedEntityTimes } =
    useCanvasCommands();
  const selectedEntities = useSelectedEntities();
  const timeParam = useParamValue("time", null);

  const sourceEntity = getTimeSourceEntity(selectedEntities);
  const firstTime = selectedEntities[0]?.shaderParams.time ?? 0;
  const firstPlaying = selectedEntities[0]?.shaderParams.timeAutoPlay !== false;
  const hasMixedTimeState = selectedEntities.some((entity) => {
    const entityTime = entity.shaderParams.time ?? 0;
    const entityPlaying = entity.shaderParams.timeAutoPlay !== false;
    return !areTimesEqual(entityTime, firstTime) || entityPlaying !== firstPlaying;
  });
  const isMixed = hasMixedTimeState || timeParam.isMixed;
  const entity = isMixed ? null : sourceEntity;
  const entityTime = sourceEntity?.shaderParams.time ?? timeParam.value ?? 0;
  const isAutoPlaying = sourceEntity ? sourceEntity.shaderParams.timeAutoPlay !== false : false;

  const handleToggle = () => {
    if (selectedEntities.length === 0) return;
    setSelectedEntityTimeAutoPlay(!isAutoPlaying);
  };

  const handleTimeChange = (time: number) => {
    if (selectedEntities.length === 0) return;
    updateSelectedEntityParams({ time }, SKIP_UNDO);
  };

  const handleTimeInteractionStart = () => {
    if (selectedEntities.length === 0) return;
    syncSelectedEntityTimes();
  };

  return {
    entity,
    entityTime,
    isAutoPlaying,
    isMixed,
    isSupported: timeParam.isSupported,
    handleToggle,
    handleTimeChange,
    handleTimeInteractionStart,
  };
}
