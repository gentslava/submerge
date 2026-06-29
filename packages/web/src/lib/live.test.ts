import { describe, expect, it } from "vitest";
import { RingBuffer } from "./live";

describe("RingBuffer", () => {
  it("keeps only the last N items", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it("starts empty and reports size", () => {
    const rb = new RingBuffer<number>(2);
    expect(rb.toArray()).toEqual([]);
    rb.push(9);
    expect(rb.toArray()).toEqual([9]);
  });
});
