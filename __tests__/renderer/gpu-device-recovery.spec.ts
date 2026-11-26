import { describe, expect, test } from "vitest";
import { GpuDeviceRecovery } from "#renderer/gpu-device-recovery.ts";

describe("GpuDeviceRecovery", () => {
  test("backs off, then gives up after consecutive failures", () => {
    const recovery = new GpuDeviceRecovery();
    expect(recovery.nextAttemptDelay(0)).toBe(250);
    expect(recovery.nextAttemptDelay(0)).toBe(1_000);
    expect(recovery.nextAttemptDelay(0)).toBe(3_000);
    expect(recovery.nextAttemptDelay(0)).toBeNull();
  });

  test("a loss shortly after recovering counts toward the same budget", () => {
    const recovery = new GpuDeviceRecovery();
    recovery.nextAttemptDelay(0);
    recovery.markReady(1_000);
    expect(recovery.nextAttemptDelay(2_000)).toBe(1_000);
  });

  test("a renderer that stayed healthy restores the full budget", () => {
    const recovery = new GpuDeviceRecovery();
    recovery.nextAttemptDelay(0);
    recovery.nextAttemptDelay(0);
    recovery.markReady(1_000);
    expect(recovery.nextAttemptDelay(60_000)).toBe(250);
  });

  test("reset restores the full budget", () => {
    const recovery = new GpuDeviceRecovery();
    for (let i = 0; i < 3; i++) recovery.nextAttemptDelay(0);
    recovery.reset();
    expect(recovery.nextAttemptDelay(0)).toBe(250);
  });
});
