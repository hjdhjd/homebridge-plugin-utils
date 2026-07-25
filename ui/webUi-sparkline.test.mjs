/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-sparkline.test.mjs: Tests for the sparkline trend-strip primitive - its geometry, its color discipline, its in-place updates, the conveyor slide's
 * lifecycle, and the trend-direction helper.
 */
"use strict";

import { createSparkline, trendDirection } from "./webUi-sparkline.mjs";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "./ui.helpers.mjs";

/* Every expected coordinate in this file is hand-computed from the module's pinned constants rather than read back from the implementation:
 *
 *   viewBox 600 x 64, right inset 8, so the plot is 592 wide and a window of n points steps by 592 / (n - 1).
 *   top pad 7, so the plot is 57 tall and y(value) = 64 - (((value - domainMin) / domainSpan) * 57).
 *   the domain is zero-inclusive: min(0, dataMin) to max(0, finite anchor, dataMax).
 *
 * A three-point window therefore steps by 296, and a window of 1, 2, 3 spans 0 to 3 and lands on 45, 26, and 7.
 */

// The strip's marks, in the order the module builds them: the hairline sits outside the sliding group so it stays put while the data moves under it.
function marksOf(element) {

  const [ hairline, group ] = element.children;
  const [ area, line, dot ] = group.children;

  return { area, dot, group, hairline, line };
}

// Parse a path's `d` back into coordinate pairs so an assertion can name the exact number it expects at one position. The close command carries no coordinates.
function coordinatesOf(pathElement) {

  const d = pathElement.getAttribute("d");

  if(!d) {

    return [];
  }

  return d.split(" ").filter((command) => command !== "Z").map((command) => {

    const [ x, y ] = command.slice(1).split(",");

    return { x: Number(x), y: Number(y) };
  });
}

// Dispatch the transition-completion event a browser would fire at the end of the slide. Happy-DOM runs no CSS transitions, so the suite plays the browser's part:
// a bubbling event carrying the property name, dispatched at whichever element the case is about.
function dispatchTransitionEnd({ propertyName = "transform", target }) {

  const event = new window.Event("transitionend", { bubbles: true });

  event.propertyName = propertyName;
  target.dispatchEvent(event);
}

// Replace the host's motion-preference reader. Assignment rather than deletion is deliberate: Happy-DOM defines matchMedia both as an own property of the window
// and on its prototype, so deleting the own property leaves a working method behind and the absence branch would never be reached.
function stubMatchMedia(matches) {

  window.matchMedia = () => ({ matches });
}

describe("createSparkline - geometry", () => {

  test("an all-positive window closes the area at the strip-bottom zero line and shows no hairline", () => {

    using _dom = createTestDom();

    const { area, hairline, line } = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the line walks the three hand-computed points");
    assert.equal(area.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00 L592.00,64.00 L0.00,64.00 Z", "the area closes at y 64, the zero line");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "a window that never dips below zero needs no hairline");
  });

  test("a window that crosses zero puts the hairline at the interpolated zero and the line dips below it", () => {

    using _dom = createTestDom();

    // Spanning -2 to 2, zero sits at the middle of the 57-unit plot: y(0) = 64 - ((2 / 4) * 57) = 35.50.
    const { hairline, line } = marksOf(createSparkline({ points: [ -2, 0, 2 ] }).element);

    assert.equal(hairline.getAttribute("visibility"), "visible", "a window that dips below zero shows the reference hairline");
    assert.equal(hairline.getAttribute("y1"), "35.50", "the hairline sits at the interpolated zero");
    assert.equal(hairline.getAttribute("y2"), "35.50", "the hairline is level");

    const [ first, middle ] = coordinatesOf(line);

    assert.equal(middle.y, 35.5, "the zero-valued sample lands exactly on the hairline");
    assert.ok(first.y > 35.5, "the negative sample renders below the hairline (larger y is lower on the strip)");
  });

  test("a flat all-negative window with no anchor puts zero at the domain's top edge and the data on the baseline", () => {

    using _dom = createTestDom();

    // Spanning -2 to 0, so the data lands on the baseline at 64 and zero lands one top pad down from the top: y(0) = 64 - ((2 / 2) * 57) = 7.00.
    const { area, hairline, line } = marksOf(createSparkline({ points: [ -2, -2, -2 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,64.00 L296.00,64.00 L592.00,64.00", "the flat negative line sits on the baseline");
    assert.equal(area.getAttribute("d"), "M0.00,64.00 L296.00,64.00 L592.00,64.00 L592.00,7.00 L0.00,7.00 Z", "the area closes up at the on-canvas zero line");
    assert.equal(hairline.getAttribute("visibility"), "visible", "an all-negative window still shows where zero is");
    assert.equal(hairline.getAttribute("y1"), "7.00", "zero renders at the domain's top edge rather than off-canvas");

    for(const { x, y } of coordinatesOf(area)) {

      assert.ok(Number.isFinite(x) && Number.isFinite(y), "every coordinate is finite");
    }
  });

  test("a non-flat all-negative window with no anchor renders zero at the top edge with all data below it", () => {

    using _dom = createTestDom();

    // Spanning -5 to 0: y(-1) = 64 - ((4 / 5) * 57) = 18.40, y(-5) = 64.00, y(-3) = 64 - ((2 / 5) * 57) = 41.20, and zero is at 7.00.
    const { hairline, line } = marksOf(createSparkline({ points: [ -1, -5, -3 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,18.40 L296.00,64.00 L592.00,41.20", "the negative window scales across the full plot height");
    assert.equal(hairline.getAttribute("y1"), "7.00", "zero renders at the domain's top edge");

    for(const { y } of coordinatesOf(line)) {

      assert.ok(y > 7, "every sample renders below the zero hairline");
    }
  });

  test("domainAnchor floors the domain top so low data renders low", () => {

    using _dom = createTestDom();

    // The anchor raises the top from 1 to 14, so the flat series draws near the floor: y(1) = 64 - ((1 / 14) * 57) = 59.93.
    const { line } = marksOf(createSparkline({ domainAnchor: 14, points: [ 1, 1, 1 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,59.93 L296.00,59.93 L592.00,59.93", "a flat low series sits near the bottom of an anchored domain");
  });

  test("domainAnchor never clips data above it", () => {

    using _dom = createTestDom();

    // The data maximum of 20 exceeds the anchor of 14, so the domain follows the data: y(20) = 7.00 and y(1) = 64 - ((1 / 20) * 57) = 61.15.
    const { line } = marksOf(createSparkline({ domainAnchor: 14, points: [ 1, 20 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,61.15 L592.00,7.00", "the spike scales to the data maximum rather than clipping at the anchor");
  });

  test("the end dot rides the last point's coordinates", () => {

    using _dom = createTestDom();

    const { dot } = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(dot.getAttribute("cx"), "592.00", "the newest sample sits at the plot's right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot takes the last sample's y");
    assert.equal(dot.getAttribute("visibility"), "visible", "a populated window shows its dot");
  });

  test("an empty window clears both paths and hides the dot", () => {

    using _dom = createTestDom();

    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [] }).element);

    assert.equal(line.getAttribute("d"), "", "no window means no line");
    assert.equal(area.getAttribute("d"), "", "no window means no area");
    assert.equal(dot.getAttribute("visibility"), "hidden", "the dot hides rather than stranding itself at the last window's position");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "there is no zero to mark");
  });

  test("a one-point window renders the lone dot at the plot's right edge with empty paths", () => {

    using _dom = createTestDom();

    // A single sample spans 0 to 5, so it lands at the domain's top: y(5) = 64 - 57 = 7.00.
    const { area, dot, line } = marksOf(createSparkline({ points: [5] }).element);

    assert.equal(line.getAttribute("d"), "", "one sample draws no line");
    assert.equal(area.getAttribute("d"), "", "one sample draws no area");
    assert.equal(dot.getAttribute("cx"), "592.00", "the lone sample is the newest sample, at the right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the lone sample takes its own value's y");
    assert.equal(dot.getAttribute("visibility"), "visible", "one sample is still something to show");
  });

  test("a flat all-zero window lands every point on the baseline", () => {

    using _dom = createTestDom();

    // The only window whose domain collapses. The guarded span of 1 puts every value at y = 64 - ((0 / 1) * 57) = 64.00.
    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [ 0, 0, 0 ] }).element);

    assert.equal(line.getAttribute("d"), "M0.00,64.00 L296.00,64.00 L592.00,64.00", "a collapsed domain lands on the baseline, not at NaN");
    assert.equal(area.getAttribute("d"), "M0.00,64.00 L296.00,64.00 L592.00,64.00 L592.00,64.00 L0.00,64.00 Z", "the area closes at the same baseline");
    assert.equal(dot.getAttribute("cy"), "64.00", "the dot lands on the baseline too");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "an all-zero window never dips below zero");
  });

  test("non-finite points are filtered before any geometry is computed", () => {

    using _dom = createTestDom();

    const filtered = marksOf(createSparkline({ points: [ 1, NaN, 2, Infinity, 3, "4" ] }).element);
    const clean = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(filtered.line.getAttribute("d"), clean.line.getAttribute("d"), "the hostile window renders exactly as the same window without its junk");
    assert.equal(filtered.area.getAttribute("d"), clean.area.getAttribute("d"), "the area matches too");
    assert.equal(filtered.dot.getAttribute("cy"), "7.00", "the dot rides the last finite sample");
  });

  test("a non-finite domainAnchor is ignored", () => {

    using _dom = createTestDom();

    const anchored = marksOf(createSparkline({ domainAnchor: NaN, points: [ 1, 2, 3 ] }).element);

    assert.equal(anchored.line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "a NaN anchor leaves the data's own domain in place");
  });
});

describe("createSparkline - color discipline", () => {

  test("every mark draws in currentColor at the pinned opacities, with the dot ringed in the surface token", () => {

    using _dom = createTestDom();

    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [ -1, 2 ] }).element);

    assert.equal(line.getAttribute("stroke"), "currentColor", "the line inherits the surrounding color");
    assert.equal(line.getAttribute("fill"), "none", "the line is a stroke, not a shape");
    assert.equal(line.getAttribute("stroke-width"), "2", "the line carries the pinned weight");
    assert.equal(line.getAttribute("vector-effect"), "non-scaling-stroke", "the line keeps its weight through the viewBox stretch");
    assert.equal(area.getAttribute("fill"), "currentColor", "the area inherits the same color as the line");
    assert.equal(area.getAttribute("fill-opacity"), "0.12", "the area reads as a tint rather than a second color statement");
    assert.equal(area.getAttribute("stroke"), "none", "the area is a fill, not a stroke");
    assert.equal(dot.getAttribute("fill"), "currentColor", "the dot inherits the same color");
    assert.equal(dot.getAttribute("r"), "4", "the dot carries the pinned radius");
    assert.equal(dot.getAttribute("stroke"), "var(--fo-surface-bg, Canvas)", "the dot's ring reads as a punch-out of the page surface");
    assert.equal(dot.getAttribute("stroke-width"), "2", "the ring carries the pinned width");
    assert.equal(hairline.getAttribute("stroke"), "currentColor", "the hairline is a faint tint of the data's own color");
    assert.equal(hairline.getAttribute("stroke-opacity"), "0.4", "the hairline carries the pinned opacity");
    assert.equal(hairline.getAttribute("stroke-width"), "1", "the hairline is a hairline");
  });
});

describe("createSparkline - updating in place", () => {

  test("update repaints the very same element and marks", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const before = marksOf(sparkline.element);

    sparkline.update({ points: [ 2, 3, 4 ] });

    const after = marksOf(sparkline.element);

    assert.equal(after.area, before.area, "the area path is the same element across updates");
    assert.equal(after.dot, before.dot, "the dot is the same element across updates");
    assert.equal(after.group, before.group, "the sliding group is the same element across updates");
    assert.equal(after.hairline, before.hairline, "the hairline is the same element across updates");
    assert.equal(after.line, before.line, "the line path is the same element across updates");
  });

  test("a plain update genuinely recomputes the geometry", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const { dot, line } = marksOf(sparkline.element);

    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the starting window renders as hand-computed");
    assert.equal(dot.getAttribute("cy"), "7.00", "the starting dot rides the last sample");

    // A four-point window steps by 592 / 3 = 197.33 and spans 0 to 4, so y = 64 - ((value / 4) * 57): 49.75, 35.50, 21.25, 7.00.
    sparkline.update({ points: [ 1, 2, 3, 4 ] });

    assert.equal(line.getAttribute("d"), "M0.00,49.75 L197.33,35.50 L394.67,21.25 L592.00,7.00", "both the spacing and the scale are recomputed");
    assert.equal(dot.getAttribute("cx"), "592.00", "the newest sample still rides the plot's right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot follows the new last sample");

    // Dropping to a two-point window spanning 0 to 40 moves every y: y(30) = 64 - ((30 / 40) * 57) = 21.25 and y(40) = 7.00.
    sparkline.update({ points: [ 30, 40 ] });

    assert.equal(line.getAttribute("d"), "M0.00,21.25 L592.00,7.00", "a shorter window rescales rather than reusing the prior geometry");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot rides the new maximum");
  });

  test("an update from an empty window brings the dot back", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [] });
    const { dot } = marksOf(sparkline.element);

    assert.equal(dot.getAttribute("visibility"), "hidden", "an empty strip starts with no dot");
    assert.equal(dot.getAttribute("cx"), null, "an empty strip never positioned its dot");

    sparkline.update({ points: [ 1, 2, 3 ] });

    assert.equal(dot.getAttribute("visibility"), "visible", "the dot returns with the data");
    assert.equal(dot.getAttribute("cx"), "592.00", "and takes its position at the right edge");
  });

  test("the strip is an image with a live accessible label", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ ariaLabel: "Prices are steady.", points: [ 1, 2, 3 ] });
    const { element } = sparkline;

    assert.equal(element.getAttribute("role"), "img", "the strip announces itself as an image");
    assert.equal(element.getAttribute("aria-label"), "Prices are steady.", "the constructed label lands on the element");

    sparkline.update({ ariaLabel: "Prices are rising.", points: [ 2, 3, 4 ] });
    assert.equal(element.getAttribute("aria-label"), "Prices are rising.", "a string label replaces the previous one");

    sparkline.update({ points: [ 3, 4, 5 ] });
    assert.equal(element.getAttribute("aria-label"), "Prices are rising.", "an omitted label leaves the previous one in place");

    sparkline.update({ ariaLabel: null, points: [ 4, 5, 6 ] });
    assert.equal(element.getAttribute("aria-label"), "Prices are rising.", "a null label leaves the previous one in place");

    sparkline.update({ ariaLabel: 42, points: [ 5, 6, 7 ] });
    assert.equal(element.getAttribute("aria-label"), "Prices are rising.", "a non-string label leaves the previous one in place");
  });

  test("a null points update renders the empty state rather than throwing", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const { dot, line } = marksOf(sparkline.element);

    sparkline.update({ points: null });

    assert.equal(line.getAttribute("d"), "", "a null window clears the line");
    assert.equal(dot.getAttribute("visibility"), "hidden", "a null window hides the dot");
  });

  test("the construction entry point normalizes its window the same way update does", () => {

    using _dom = createTestDom();

    const empty = marksOf(createSparkline({ points: null }).element);

    assert.equal(empty.line.getAttribute("d"), "", "a null construction window renders the empty state");
    assert.equal(empty.dot.getAttribute("visibility"), "hidden", "a null construction window hides the dot");

    const hostile = createSparkline({ points: [ NaN, 1, 2, Infinity, 3 ] });

    assert.equal(marksOf(hostile.element).line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "a NaN-bearing construction window is filtered first");

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // The remembered window is the normalized one, so the slide's shape check reads what was actually drawn: 1, 2, 3 advanced by one is a clean one-step shift.
      hostile.update({ points: [ 2, 3, 4 ], slide: true });

      assert.notEqual(marksOf(hostile.element).group.style.transition, "", "the shift is measured against the normalized window, so the slide is recognized");
    } finally {

      mock.timers.reset();
    }
  });
});

describe("createSparkline - the conveyor slide", () => {

  test("a one-step shift animates the union window by exactly one step", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { dot, group, line } = marksOf(sparkline.element);

    // Virtual time throughout the slide cases that leave a slide in flight, so the fallback timer this arms is discarded at teardown rather than outliving the test.
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the group carries the pinned duration and easing");
      assert.equal(group.style.transform, "translateX(-296.00px)", "the group travels exactly one window step");

      // The union is the outgoing 10 plus the new window, drawn at the settled window's own step of 296 - so it reaches one step past the plot's right edge - and
      // scaled on the union's own domain of 0 to 10, where y = 64 - ((value / 10) * 57): 7.00, 58.30, 52.60, 46.90.
      const union = coordinatesOf(line);

      assert.equal(union.length, 4, "the union carries the outgoing sample alongside the new window");
      assert.equal(union[0].x, 0, "the union starts at the plot's left edge");
      assert.equal(union[3].x, 888, "the incoming sample waits one step beyond the plot's right edge");
      assert.equal(union[3].y, 46.9, "the union is scaled on the union's own domain, not the new window's");
      assert.equal(union[0].y, 7, "the outgoing extreme still sets the top of that shared domain");
      assert.equal(dot.getAttribute("cx"), "888.00", "the dot rides the incoming sample in from beyond the edge");
    } finally {

      mock.timers.reset();
    }
  });

  test("a transitionend on the group settles the slide", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the settled group carries no transform");
    assert.equal(group.style.transition, "", "the settled group carries no transition");
    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the settled strip carries the plain new window");
  });

  test("the fallback timer settles the slide when no transitionend arrives", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transform, "translateX(-296.00px)", "the slide is under way before the clock advances");

      // The fallback fires one margin past the slide's nominal end: 400 + 60.
      mock.timers.tick(460);

      assert.equal(group.style.transform, "", "the fallback cleared the transform");
      assert.equal(group.style.transition, "", "the fallback cleared the transition");
      assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the fallback painted the plain new window");
    } finally {

      mock.timers.reset();
    }
  });

  test("a transitionend from a child or for another property does not settle the slide", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    dispatchTransitionEnd({ target: line });

    assert.equal(group.style.transform, "translateX(-296.00px)", "a child's transition must not cut the slide short");

    dispatchTransitionEnd({ propertyName: "opacity", target: group });

    assert.equal(group.style.transform, "translateX(-296.00px)", "another property's transition must not cut the slide short");

    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the group's own transform transition does settle it");
  });

  test("settling on transitionend cancels the fallback timer outright", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // Watching the cancellation itself is what separates "cancelled" from "fired and found nothing to do". The record guard makes both outcomes look identical
      // in the DOM, so the sentinel below cannot tell them apart on its own.
      const clearSpy = mock.fn(globalThis.clearTimeout);

      globalThis.clearTimeout = clearSpy;

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });
      dispatchTransitionEnd({ target: group });

      assert.equal(clearSpy.mock.callCount(), 1, "the settle cancelled the fallback timer outright");

      // The sentinel then proves nothing repainted afterwards: any late repaint of any kind would overwrite it.
      line.setAttribute("d", "SENTINEL");
      mock.timers.tick(1000);

      assert.equal(line.getAttribute("d"), "SENTINEL", "the fallback timer never ran");
    } finally {

      mock.timers.reset();
    }
  });

  test("settling on the fallback timer removes the transitionend listener outright", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // The mirror of the cancellation watch above: the removal is what separates "detached" from "still attached but stopped by the record guard".
      const removeSpy = mock.fn(group.removeEventListener.bind(group));

      group.removeEventListener = removeSpy;

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });
      mock.timers.tick(460);

      assert.equal(removeSpy.mock.callCount(), 1, "the settle detached the transition listener outright");

      line.setAttribute("d", "SENTINEL");
      dispatchTransitionEnd({ target: group });

      assert.equal(line.getAttribute("d"), "SENTINEL", "the late transition event found no listener to settle through");
    } finally {

      mock.timers.reset();
    }
  });

  test("chained slides each animate and settle", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    assert.equal(group.style.transform, "translateX(-296.00px)", "the first cycle animates");

    dispatchTransitionEnd({ target: group });

    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the first cycle settles on its window");

    sparkline.update({ points: [ 2, 3, 4 ], slide: true });

    assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the second cycle re-arms the transition");
    assert.equal(group.style.transform, "translateX(-296.00px)", "the second cycle animates by the same one step");

    // The second union is 1, 2, 3, 4 on a domain of 0 to 4, where y = 64 - ((value / 4) * 57): 49.75, 35.50, 21.25, 7.00.
    assert.equal(line.getAttribute("d"), "M0.00,49.75 L296.00,35.50 L592.00,21.25 L888.00,7.00", "the second union is drawn on its own shared domain");

    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the second cycle settles clean");
    assert.equal(line.getAttribute("d"), "M0.00,35.50 L296.00,21.25 L592.00,7.00", "the second cycle settles on its window");
  });

  test("an update arriving mid-slide cancels the pending settle and wins", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });
      sparkline.update({ points: [ 30, 40 ] });

      assert.equal(group.style.transform, "", "the newer window clears the abandoned slide's transform");
      assert.equal(group.style.transition, "", "the newer window clears the abandoned slide's transition");
      assert.equal(line.getAttribute("d"), "M0.00,21.25 L592.00,7.00", "the newer window is what renders");

      // Neither abandoned mechanism may land on top of the newer window.
      dispatchTransitionEnd({ target: group });
      mock.timers.tick(1000);

      assert.equal(line.getAttribute("d"), "M0.00,21.25 L592.00,7.00", "the abandoned slide never repaints over the newer window");
    } finally {

      mock.timers.reset();
    }
  });

  test("an update arriving mid-slide applies instantly even when it asks to slide", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    sparkline.update({ points: [ 2, 3, 4 ], slide: true });

    assert.equal(group.style.transition, "", "no second transition arms mid-cycle");
    assert.equal(group.style.transform, "", "the group is left parked, not part-way through a transform");
    assert.equal(line.getAttribute("d"), "M0.00,35.50 L296.00,21.25 L592.00,7.00", "the newest window renders immediately");
  });

  test("a detached element settles harmlessly", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    document.body.append(sparkline.element);
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    sparkline.element.remove();

    assert.doesNotThrow(() => dispatchTransitionEnd({ target: group }), "settling a detached strip throws nothing");
    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the detached strip still holds its settled geometry");
  });

  test("a window that is not a one-step shift repaints instantly", () => {

    using _dom = createTestDom();

    // Every mismatch shape: shifted by two, shorter, longer, and - the case that actually convicts an endpoint-only comparison - a window whose first element
    // matches the previous window's second while its interior differs. The shifted-by-two fixture already mismatches at the first overlap, so only the
    // interior-corruption row proves the shape check reads every overlapping element rather than the endpoints alone.
    const cases = [

      { expected: "M0.00,35.50 L197.33,26.00 L394.67,16.50 L592.00,7.00", label: "shifted by two", points: [ 3, 4, 5, 6 ], start: [ 1, 2, 3, 4 ] },
      { expected: "M0.00,26.00 L592.00,7.00", label: "shorter", points: [ 2, 3 ], start: [ 1, 2, 3 ] },
      { expected: "M0.00,49.75 L197.33,35.50 L394.67,21.25 L592.00,7.00", label: "longer", points: [ 1, 2, 3, 4 ], start: [ 1, 2, 3 ] },
      { expected: "M0.00,51.33 L197.33,7.00 L394.67,7.00 L592.00,32.33", label: "interior corruption behind a matching first overlap", points: [ 2, 9, 9, 5 ],
        start: [ 1, 2, 3, 4 ] }
    ];

    for(const { expected, label, points, start } of cases) {

      const sparkline = createSparkline({ points: start });
      const { group, line } = marksOf(sparkline.element);

      sparkline.update({ points, slide: true });

      assert.equal(group.style.transition, "", label + ": no transition arms for a window the slide cannot honestly animate");
      assert.equal(group.style.transform, "", label + ": the group never moves");
      assert.equal(line.getAttribute("d"), expected, label + ": the new window is painted instantly");
    }
  });

  test("reduced motion is read at each update, not cached at construction", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    stubMatchMedia(true);
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    assert.equal(group.style.transition, "", "a preference set after construction still suppresses the animation");
    assert.equal(group.style.transform, "", "the group never moves under reduced motion");
    assert.equal(line.getAttribute("d"), "M0.00,45.00 L296.00,26.00 L592.00,7.00", "the new window is painted instantly instead");
  });

  test("a host without matchMedia reads as no preference and slides", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group } = marksOf(sparkline.element);

    window.matchMedia = undefined;
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the absent reader is no preference, so the slide proceeds");
      assert.equal(group.style.transform, "translateX(-296.00px)", "and the group travels its one step");
    } finally {

      mock.timers.reset();
    }
  });

  test("a host reporting no reduced-motion preference slides", () => {

    using _dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group } = marksOf(sparkline.element);

    stubMatchMedia(false);
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "an explicit no-preference host animates");
      assert.equal(group.style.transform, "translateX(-296.00px)", "and the group travels its one step");
    } finally {

      mock.timers.reset();
    }
  });
});

describe("trendDirection", () => {

  test("reports the direction across the window", () => {

    assert.equal(trendDirection({ points: [ 1, 2, 5 ] }), "rising", "a window ending above where it started is rising");
    assert.equal(trendDirection({ points: [ 5, 2, 1 ] }), "falling", "a window ending below where it started is falling");
    assert.equal(trendDirection({ points: [ 3, 9, 3 ] }), "steady", "the reading is first to last, whatever happened in between");
  });

  test("honors the deadband, inclusive of its boundary", () => {

    assert.equal(trendDirection({ deadband: 1, points: [ 1, 1.5 ] }), "steady", "a change inside the deadband is no change");
    assert.equal(trendDirection({ deadband: 4, points: [ 1, 5 ] }), "steady", "a change of exactly the deadband is still no change");
    assert.equal(trendDirection({ deadband: 4, points: [ 1, 5.5 ] }), "rising", "a change past the deadband reports its direction");
    assert.equal(trendDirection({ deadband: 4, points: [ 5.5, 1 ] }), "falling", "and reports it in the other direction too");
  });

  test("a negative or non-finite deadband reads as zero", () => {

    assert.equal(trendDirection({ deadband: -3, points: [ 2, 2 ] }), "steady", "a flat window is steady no matter what the deadband says");
    assert.equal(trendDirection({ deadband: -3, points: [ 2, 2.5 ] }), "rising", "a negative deadband cannot suppress a real change");
    assert.equal(trendDirection({ deadband: NaN, points: [ 2, 2.5 ] }), "rising", "a non-finite deadband cannot either");
  });

  test("guards windows too short to have a direction", () => {

    assert.equal(trendDirection({ points: [] }), "steady", "an empty window has no direction to report");
    assert.equal(trendDirection({ points: [5] }), "steady", "one sample has nothing to compare against");
    assert.equal(trendDirection({ points: null }), "steady", "a null window has no direction to report");
    assert.equal(trendDirection({ points: [ NaN, Infinity ] }), "steady", "a window with nothing finite in it is an empty window");
  });
});
