import { describe, it, expect } from "vitest";
import { detectLifecycleMarker } from "../priceListLifecycle";

describe("detectLifecycleMarker", () => {
  it("flags high-urgency end-of-life markers", () => {
    expect(detectLifecycleMarker("No integrated SoC media player. EOL Jan 2026.")).toEqual({
      match: "EOL",
      urgency: "high",
    });
    expect(detectLifecycleMarker("End of Life: 2025")?.urgency).toBe("high");
    expect(detectLifecycleMarker("This model is discontinued")?.urgency).toBe("high");
    expect(detectLifecycleMarker("Last Time Buy 31/12/2026")?.urgency).toBe("high");
  });

  it("flags medium-urgency lifecycle markers", () => {
    expect(detectLifecycleMarker("[EOL – successor: 7213-11]")?.urgency).toBe("high"); // EOL wins
    expect(detectLifecycleMarker("successor: 7213-11")?.urgency).toBe("medium");
    expect(detectLifecycleMarker("Legacy product, see replacement")?.urgency).toBe("medium");
  });

  it("returns null for normal descriptions", () => {
    expect(detectLifecycleMarker("4K UHD professional display, 500 cd/m²")).toBeNull();
    expect(detectLifecycleMarker("")).toBeNull();
    expect(detectLifecycleMarker(null)).toBeNull();
  });

  it("does not match LTB inside an unrelated word", () => {
    expect(detectLifecycleMarker("subtle blend")).toBeNull();
    expect(detectLifecycleMarker("LTB")?.urgency).toBe("high");
  });
});
