// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not dispatch before the delay elapses", () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    result.current.schedule("a");
    vi.advanceTimersByTime(299);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("collapses a burst into a single dispatch with the latest value", () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    result.current.schedule("a");
    vi.advanceTimersByTime(200);
    result.current.schedule("ab");
    vi.advanceTimersByTime(200);
    result.current.schedule("abc");
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledExactlyOnceWith("abc");
  });

  it("flush dispatches the pending value immediately", () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    result.current.schedule("a");
    result.current.flush();
    expect(spy).toHaveBeenCalledExactlyOnceWith("a");

    // Nothing further fires when the timer would have elapsed.
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending value", () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    result.current.schedule("a");
    result.current.cancel();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.isPending()).toBe(false);
  });

  it("flushes the pending value on unmount", () => {
    const spy = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(spy, 300));

    result.current.schedule("last words");
    unmount();
    expect(spy).toHaveBeenCalledExactlyOnceWith("last words");
  });

  it("reports pending state", () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    expect(result.current.isPending()).toBe(false);
    result.current.schedule("a");
    expect(result.current.isPending()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(result.current.isPending()).toBe(false);
  });
});
