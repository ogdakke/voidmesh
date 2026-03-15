/**
 * Tests for media time formatting utilities
 */
import { describe, test, expect } from "vite-plus/test";
import { formatMediaTime, formatMediaTimeParts } from "#lib/time-format.ts";

describe("formatMediaTime", () => {
  describe("seconds under 60", () => {
    test("formats 0 seconds as 0:00", () => {
      expect(formatMediaTime(0)).toBe("0:00");
    });

    test("formats whole seconds", () => {
      expect(formatMediaTime(5)).toBe("5:00");
      expect(formatMediaTime(45)).toBe("45:00");
      expect(formatMediaTime(59)).toBe("59:00");
    });

    test("formats seconds with centiseconds", () => {
      expect(formatMediaTime(45.32)).toBe("45:32");
      expect(formatMediaTime(5.1)).toBe("5:10");
      expect(formatMediaTime(12.05)).toBe("12:05");
    });

    test("pads centiseconds correctly", () => {
      expect(formatMediaTime(5.05)).toBe("5:05");
      expect(formatMediaTime(5.5)).toBe("5:50");
      expect(formatMediaTime(5.01)).toBe("5:01");
    });

    test("handles edge case at 59.99 seconds", () => {
      expect(formatMediaTime(59.99)).toBe("59:99");
    });
  });

  describe("seconds >= 60", () => {
    test("formats exactly 60 seconds as 1:00:00", () => {
      expect(formatMediaTime(60)).toBe("1:00:00");
    });

    test("formats minutes with seconds and centiseconds", () => {
      expect(formatMediaTime(90.5)).toBe("1:30:50");
      expect(formatMediaTime(125.05)).toBe("2:05:05");
    });

    test("pads seconds correctly in minutes format", () => {
      expect(formatMediaTime(65.05)).toBe("1:05:05");
      expect(formatMediaTime(61)).toBe("1:01:00");
      expect(formatMediaTime(69.99)).toBe("1:09:99");
    });

    test("handles multiple minutes", () => {
      expect(formatMediaTime(120)).toBe("2:00:00");
      expect(formatMediaTime(180.5)).toBe("3:00:50");
      expect(formatMediaTime(300.25)).toBe("5:00:25");
    });

    test("handles long durations", () => {
      expect(formatMediaTime(3600)).toBe("60:00:00");
      expect(formatMediaTime(3661.5)).toBe("61:01:50");
    });
  });

  describe("edge cases", () => {
    test("handles negative values by treating as 0", () => {
      expect(formatMediaTime(-5)).toBe("0:00");
      expect(formatMediaTime(-100)).toBe("0:00");
    });

    test("handles NaN by treating as 0", () => {
      expect(formatMediaTime(NaN)).toBe("0:00");
    });

    test("handles Infinity by treating as 0", () => {
      expect(formatMediaTime(Infinity)).toBe("0:00");
      expect(formatMediaTime(-Infinity)).toBe("0:00");
    });

    test("rounds centiseconds correctly", () => {
      // 5.999 rounds to 6:00 (nearest centisecond)
      expect(formatMediaTime(5.999)).toBe("6:00");
      // 5.994 rounds down to 5:99
      expect(formatMediaTime(5.994)).toBe("5:99");
      // 5.001 rounds down to 5:00
      expect(formatMediaTime(5.001)).toBe("5:00");
    });
  });
});

describe("formatMediaTimeParts", () => {
  describe("seconds under 60", () => {
    test("formats 0 seconds", () => {
      const result = formatMediaTimeParts(0);
      expect(result.main).toBe("0");
      expect(result.ms).toBe("00");
    });

    test("formats whole seconds", () => {
      expect(formatMediaTimeParts(5)).toEqual({ main: "5", ms: "00" });
      expect(formatMediaTimeParts(45)).toEqual({ main: "45", ms: "00" });
      expect(formatMediaTimeParts(59)).toEqual({ main: "59", ms: "00" });
    });

    test("formats seconds with centiseconds", () => {
      expect(formatMediaTimeParts(45.32)).toEqual({ main: "45", ms: "32" });
      expect(formatMediaTimeParts(5.1)).toEqual({ main: "5", ms: "10" });
      expect(formatMediaTimeParts(12.05)).toEqual({ main: "12", ms: "05" });
    });

    test("pads centiseconds correctly", () => {
      expect(formatMediaTimeParts(5.05)).toEqual({ main: "5", ms: "05" });
      expect(formatMediaTimeParts(5.5)).toEqual({ main: "5", ms: "50" });
      expect(formatMediaTimeParts(5.01)).toEqual({ main: "5", ms: "01" });
    });
  });

  describe("seconds >= 60", () => {
    test("formats exactly 60 seconds", () => {
      const result = formatMediaTimeParts(60);
      expect(result.main).toBe("1:00");
      expect(result.ms).toBe("00");
    });

    test("formats minutes with seconds and centiseconds", () => {
      expect(formatMediaTimeParts(90.5)).toEqual({ main: "1:30", ms: "50" });
      expect(formatMediaTimeParts(125.05)).toEqual({ main: "2:05", ms: "05" });
    });

    test("pads seconds correctly in minutes format", () => {
      expect(formatMediaTimeParts(65.05)).toEqual({ main: "1:05", ms: "05" });
      expect(formatMediaTimeParts(61)).toEqual({ main: "1:01", ms: "00" });
      expect(formatMediaTimeParts(69.99)).toEqual({ main: "1:09", ms: "99" });
    });

    test("handles multiple minutes", () => {
      expect(formatMediaTimeParts(120)).toEqual({ main: "2:00", ms: "00" });
      expect(formatMediaTimeParts(180.5)).toEqual({ main: "3:00", ms: "50" });
      expect(formatMediaTimeParts(300.25)).toEqual({ main: "5:00", ms: "25" });
    });

    test("handles long durations", () => {
      expect(formatMediaTimeParts(3600)).toEqual({ main: "60:00", ms: "00" });
      expect(formatMediaTimeParts(3661.5)).toEqual({ main: "61:01", ms: "50" });
    });
  });

  describe("edge cases", () => {
    test("handles negative values by treating as 0", () => {
      expect(formatMediaTimeParts(-5)).toEqual({ main: "0", ms: "00" });
      expect(formatMediaTimeParts(-100)).toEqual({ main: "0", ms: "00" });
    });

    test("handles NaN by treating as 0", () => {
      expect(formatMediaTimeParts(NaN)).toEqual({ main: "0", ms: "00" });
    });

    test("handles Infinity by treating as 0", () => {
      expect(formatMediaTimeParts(Infinity)).toEqual({ main: "0", ms: "00" });
      expect(formatMediaTimeParts(-Infinity)).toEqual({ main: "0", ms: "00" });
    });

    test("rounds centiseconds correctly", () => {
      // 5.999 rounds to 6:00
      expect(formatMediaTimeParts(5.999)).toEqual({ main: "6", ms: "00" });
      // 5.994 rounds down to 5:99
      expect(formatMediaTimeParts(5.994)).toEqual({ main: "5", ms: "99" });
      // 5.001 rounds down to 5:00
      expect(formatMediaTimeParts(5.001)).toEqual({ main: "5", ms: "00" });
    });
  });

  describe("consistency with formatMediaTime", () => {
    test("parts concatenate to match formatMediaTime output", () => {
      const testCases = [0, 5, 45.32, 59.99, 60, 90.5, 125.05, 3661.5];

      for (const seconds of testCases) {
        const formatted = formatMediaTime(seconds);
        const parts = formatMediaTimeParts(seconds);
        const reconstructed = `${parts.main}:${parts.ms}`;
        expect(reconstructed).toBe(formatted);
      }
    });
  });
});
