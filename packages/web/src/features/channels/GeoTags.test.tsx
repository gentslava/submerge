import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeoIpTags, GeoSiteTags } from "./GeoTags";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => vi.clearAllMocks());

describe("GeoSiteTags", () => {
  it("adds a lowercase category on Enter", () => {
    const onChange = vi.fn();
    render(<GeoSiteTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить категорию GEOSITE");
    fireEvent.change(input, { target: { value: "youtube" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["youtube"]);
  });
});

describe("GeoIpTags", () => {
  it("upper-cases a country code on entry (ru → RU)", () => {
    const onChange = vi.fn();
    render(<GeoIpTags value={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Добавить код GEOIP");
    fireEvent.change(input, { target: { value: "ru" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["RU"]);
  });
});
