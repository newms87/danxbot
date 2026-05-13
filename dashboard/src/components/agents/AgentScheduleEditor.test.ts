import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { DanxRangeSlider, DanxToggle } from "@thehammer/danx-ui";
import AgentScheduleEditor from "./AgentScheduleEditor.vue";
import type { AgentSchedule } from "../../types";

function blankSchedule(over: Partial<AgentSchedule> = {}): AgentSchedule {
  return {
    tz: "America/Chicago",
    always_on: false,
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
    ...over,
  };
}

function toggleByTest(w: VueWrapper, dataTest: string) {
  const node = w.find(`[data-test="${dataTest}"]`);
  if (!node.exists()) throw new Error(`Missing data-test="${dataTest}"`);
  return node.getComponent(DanxToggle);
}

function sliderByDay(w: VueWrapper, day: string) {
  const block = w.find(`[data-test="agent-schedule-${day}-window"]`);
  if (!block.exists()) {
    throw new Error(`No window block for ${day} (day disabled or always_on)`);
  }
  return block.getComponent(DanxRangeSlider);
}

function lastEmission(w: VueWrapper): AgentSchedule {
  const emissions = w.emitted("update:modelValue");
  if (!emissions || emissions.length === 0) {
    throw new Error("No update:modelValue emission");
  }
  return emissions[emissions.length - 1][0] as AgentSchedule;
}

function renderSlotText(
  slot: (scope: { value: number; handle: "single" | "min" | "max" }) => unknown,
  value: number,
  handle: "single" | "min" | "max",
): string {
  const Probe = defineComponent({
    setup: () => () => h("div", null, slot({ value, handle }) as never),
  });
  return mount(Probe).text();
}

describe("AgentScheduleEditor", () => {
  it("the parent template uses zero native checkbox or range inputs (AC)", () => {
    // Source-scan the SFC template block — DanxToggle / DanxRangeSlider
    // render native inputs INTERNALLY (acceptable, owned by danx-ui), but
    // the AC forbids the parent template from declaring them.
    // vitest runs with cwd at `dashboard/` (see vitest.config.ts).
    const sfcPath = resolve(
      process.cwd(),
      "src/components/agents/AgentScheduleEditor.vue",
    );
    const src = readFileSync(sfcPath, "utf8");
    const tpl = /<template>([\s\S]*?)<\/template>/.exec(src)?.[1] ?? "";
    expect(tpl).not.toMatch(/<input[^>]+type="checkbox"/);
    expect(tpl).not.toMatch(/<input[^>]+type="range"/);
  });

  it("renders DanxToggle for the 24/7 master plus one per day (8 total)", () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule() },
    });
    expect(w.findAllComponents(DanxToggle)).toHaveLength(8);
    expect(toggleByTest(w, "agent-schedule-always-on").props("ariaLabel")).toBe(
      "Always on (24/7)",
    );
  });

  it("emits update:modelValue with always_on=true when the master flips ON, preserving per-day arrays", async () => {
    const w = mount(AgentScheduleEditor, {
      props: {
        modelValue: blankSchedule({
          mon: ["09:00-17:00"],
          tue: ["08:30-12:00"],
        }),
      },
    });
    await toggleByTest(w, "agent-schedule-always-on").vm.$emit(
      "update:modelValue",
      true,
    );
    const next = lastEmission(w);
    expect(next.always_on).toBe(true);
    // Data round-trip: per-day windows are NOT cleared by 24/7 flip.
    expect(next.mon).toEqual(["09:00-17:00"]);
    expect(next.tue).toEqual(["08:30-12:00"]);
  });

  it("emits always_on=false on master OFF, leaving per-day windows resurfacable", async () => {
    // Parent owns state — mount with always_on=true, flip master OFF,
    // re-mount with the next state and confirm the day window + slider
    // reappear.
    const initial = blankSchedule({
      always_on: true,
      mon: ["09:00-17:00"],
    });
    const w = mount(AgentScheduleEditor, { props: { modelValue: initial } });
    await toggleByTest(w, "agent-schedule-always-on").vm.$emit(
      "update:modelValue",
      false,
    );
    const next = lastEmission(w);
    expect(next.always_on).toBe(false);
    expect(next.mon).toEqual(["09:00-17:00"]);
    await w.setProps({ modelValue: next });
    const slider = sliderByDay(w, "mon");
    expect(slider.props("modelValue")).toEqual([540, 1020]);
  });

  it("dims the day grid and disables every per-day DanxToggle when always_on is true", () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ always_on: true }) },
    });
    const grid = w.find('[aria-disabled="true"].day-grid');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).toContain("dim");
    for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
      expect(
        toggleByTest(w, `agent-schedule-${day}-enabled`).props("disabled"),
      ).toBe(true);
    }
  });

  it("renders no DanxRangeSlider when always_on is true (per-day windows hidden)", () => {
    const w = mount(AgentScheduleEditor, {
      props: {
        modelValue: blankSchedule({
          always_on: true,
          mon: ["09:00-17:00"],
          wed: ["10:00-14:00"],
        }),
      },
    });
    expect(w.findAllComponents(DanxRangeSlider)).toHaveLength(0);
  });

  it("renders one DanxRangeSlider per enabled day", () => {
    const w = mount(AgentScheduleEditor, {
      props: {
        modelValue: blankSchedule({
          mon: ["09:00-17:00"],
          wed: ["10:00-14:00"],
          fri: ["08:00-16:00"],
        }),
      },
    });
    expect(w.findAllComponents(DanxRangeSlider)).toHaveLength(3);
  });

  it("DanxRangeSlider receives min=0, max=1440, step=15 and the parsed [start, end] tuple", () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["09:00-17:00"] }) },
    });
    const slider = sliderByDay(w, "mon");
    expect(slider.props("min")).toBe(0);
    expect(slider.props("max")).toBe(1440);
    expect(slider.props("step")).toBe(15);
    expect(slider.props("modelValue")).toEqual([540, 1020]);
  });

  it("emits formatted HH:MM-HH:MM when the slider value changes", async () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["09:00-17:00"] }) },
    });
    await sliderByDay(w, "mon").vm.$emit("update:modelValue", [600, 1080]);
    expect(lastEmission(w).mon).toEqual(["10:00-18:00"]);
  });

  it("clamps the 24:00 sentinel to 23:59 on save (backend regex compliance)", async () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["09:00-17:00"] }) },
    });
    await sliderByDay(w, "mon").vm.$emit("update:modelValue", [0, 1440]);
    expect(lastEmission(w).mon).toEqual(["00:00-23:59"]);
  });

  it("clamps near-max boundary so the upper handle never persists 24:00", async () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["09:00-17:00"] }) },
    });
    await sliderByDay(w, "mon").vm.$emit("update:modelValue", [1425, 1440]);
    expect(lastEmission(w).mon).toEqual(["23:45-23:59"]);
  });

  it("falls back to a default window when modelValue contains a malformed window string", () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["garbage"] }) },
    });
    // Day reads as enabled (windows.length > 0), slider falls back to the
    // 9-5 default since the string failed to parse.
    const slider = sliderByDay(w, "mon");
    expect(slider.props("modelValue")).toEqual([540, 1020]);
  });

  it("toggling a day OFF clears windows[]; toggling back ON restores the LAST EDITED window, not the default", async () => {
    // Sequence — start with 10:00-14:00, edit via slider to 11:00-15:00,
    // toggle day OFF, toggle day back ON. The cache should hand back the
    // edited window (11:00-15:00), not the default (09:00-17:00).
    const initial = blankSchedule({ mon: ["10:00-14:00"] });
    const w = mount(AgentScheduleEditor, { props: { modelValue: initial } });

    await sliderByDay(w, "mon").vm.$emit("update:modelValue", [660, 900]);
    const afterEdit = lastEmission(w);
    expect(afterEdit.mon).toEqual(["11:00-15:00"]);
    await w.setProps({ modelValue: afterEdit });

    await toggleByTest(w, "agent-schedule-mon-enabled").vm.$emit(
      "update:modelValue",
      false,
    );
    const afterOff = lastEmission(w);
    expect(afterOff.mon).toEqual([]);
    await w.setProps({ modelValue: afterOff });

    await toggleByTest(w, "agent-schedule-mon-enabled").vm.$emit(
      "update:modelValue",
      true,
    );
    expect(lastEmission(w).mon).toEqual(["11:00-15:00"]);
  });

  it("toggling a previously-untouched day ON populates the 9-5 default", async () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule() },
    });
    await toggleByTest(w, "agent-schedule-tue-enabled").vm.$emit(
      "update:modelValue",
      true,
    );
    expect(lastEmission(w).tue).toEqual(["09:00-17:00"]);
  });

  it("renders the value-slot label using formatHHMM for both handles", () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ mon: ["09:00-17:00"] }) },
    });
    const slot = sliderByDay(w, "mon").vm.$slots.value;
    expect(slot).toBeDefined();
    expect(renderSlotText(slot!, 540, "min")).toBe("09:00");
    expect(renderSlotText(slot!, 1020, "max")).toBe("17:00");
    // 24:00 sentinel still clamps in the bubble (operator never sees 24:00).
    expect(renderSlotText(slot!, 1440, "max")).toBe("23:59");
  });

  it("two-way binds the timezone input", async () => {
    const w = mount(AgentScheduleEditor, {
      props: { modelValue: blankSchedule({ tz: "UTC" }) },
    });
    const tzInput = w.find<HTMLInputElement>(
      '[data-test="agent-schedule-tz"]',
    );
    expect(tzInput.element.value).toBe("UTC");
    await tzInput.setValue("America/Chicago");
    expect(lastEmission(w).tz).toBe("America/Chicago");
  });
});
