import { getCssVarPx } from "#lib/css.ts";
import { DrawerSnapPoint } from "#types/enums.ts";

export class SnapPoints {
  static drawerSnapPointMedium: number | undefined;
  static snapPoints: DrawerSnapPoint[];

  static compute() {
    SnapPoints.drawerSnapPointMedium ??= getCssVarPx("--drawer-snap-medium");

    return (SnapPoints.snapPoints ??= [SnapPoints.drawerSnapPointMedium, DrawerSnapPoint.full]);
  }
}
