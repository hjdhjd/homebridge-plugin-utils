/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-sparkline.test.mjs: Tests for the sparkline trend-strip primitive - its geometry, its color discipline, its in-place updates, the conveyor slide's
 * lifecycle, pointer scrubbing with its cursor marks and its hovered-sample callback, and the trend-direction helper.
 */
"use strict";

import { createSparkline, trendDirection } from "./webUi-sparkline.mjs";
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "./ui.helpers.mjs";

/* Every expected coordinate in this file is hand-computed from the module's fixed constants rather than read back from the implementation:
 *
 *   viewBox 600 x 64, left and right insets of 8, so the plot is 584 wide, a window of n points steps by 584 / (n - 1), and sample i sits at x = 8 + (i * step).
 *   a lone sample has no step to space it by and sits at the plot's right edge, x = 592.
 *   top pad 7, so the plot is 57 tall and y(value) = 64 - (((value - domainMin) / domainSpan) * 57).
 *   the domain is zero-inclusive: min(0, dataMin) to max(0, finite anchor, dataMax).
 *
 * A three-point window therefore steps by 292, with its samples at x 8, 300, and 592, and a window of 1, 2, 3 spans 0 to 3 and lands on 45, 26, and 7.
 *
 * The scrub cases stub a border box of left 100 and width 300, so a pointer at clientX c sits at viewBox x(c) = ((c - 100) / 300) * 600, and the sample it
 * resolves to is round((x - 8) / step), clamped to the window: for x(250) = 300, round(292 / 292) = 1, index 1 of a three-point window, and for x(350) = 500,
 * round(492 / 292) = 2, index 2.
 */

// The strip's marks, in the order the module builds them: the hairline sits outside the sliding group so it stays put while the data moves under it, and a strip
// built with a scrub callback appends its cursor line and dot after the group, so they draw above the data and never move with it. A strip built without one
// carries no cursor, and its cursor fields read undefined.
function marksOf(element) {

  const [ hairline, group, cursorLine, cursorDot ] = element.children;
  const [ area, line, dot ] = group.children;

  return { area, cursorDot, cursorLine, dot, group, hairline, line };
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

// The border box the scrub cases stub in: left 100 and width 300. Happy-DOM runs no layout, so the suite plays its part, and the box carries an offset and a
// scale of its own so a mapping that ignores the offset or the scale lands on a different sample.
const SCRUB_RECT = { left: 100, width: 300 };

// Build a strip wired for scrubbing and place it on the page, because the scrub treats a strip that is off the page as having nothing under the pointer. The box
// is stubbed on the element itself, so a case can swap it mid-flight.
function scrubbableSparkline({ domainAnchor = undefined, points = [ 1, 2, 3 ], rect = SCRUB_RECT } = {}) {

  const onScrub = mock.fn();
  const sparkline = createSparkline({ domainAnchor, onScrub, points });

  sparkline.element.getBoundingClientRect = () => rect;
  document.body.append(sparkline.element);

  return { onScrub, sparkline };
}

// Dispatch a pointer event at the strip, carrying the horizontal position the scrub maps.
function dispatchPointer({ clientX = 0, target, type }) {

  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX }));
}

// The samples the scrub callback has been handed so far, in order.
function reportsOf(onScrub) {

  return onScrub.mock.calls.map((call) => call.arguments[0]);
}

describe("createSparkline - geometry", () => {

  test("an all-positive window closes the area at the strip-bottom zero line and shows no hairline", () => {

    using dom = createTestDom();

    const { area, hairline, line } = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the line walks the three hand-computed points");
    assert.equal(area.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00 L592.00,64.00 L8.00,64.00 Z", "the area closes at y 64, the zero line");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "a window that never dips below zero needs no hairline");
  });

  test("a window that crosses zero puts the hairline at the interpolated zero and the line dips below it", () => {

    using dom = createTestDom();

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

    using dom = createTestDom();

    // Spanning -2 to 0, so the data lands on the baseline at 64 and zero lands one top pad down from the top: y(0) = 64 - ((2 / 2) * 57) = 7.00.
    const { area, hairline, line } = marksOf(createSparkline({ points: [ -2, -2, -2 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,64.00 L300.00,64.00 L592.00,64.00", "the flat negative line sits on the baseline");
    assert.equal(area.getAttribute("d"), "M8.00,64.00 L300.00,64.00 L592.00,64.00 L592.00,7.00 L8.00,7.00 Z", "the area closes up at the on-canvas zero line");
    assert.equal(hairline.getAttribute("visibility"), "visible", "an all-negative window still shows where zero is");
    assert.equal(hairline.getAttribute("y1"), "7.00", "zero renders at the domain's top edge rather than off-canvas");

    for(const { x, y } of coordinatesOf(area)) {

      assert.ok(Number.isFinite(x) && Number.isFinite(y), "every coordinate is finite");
    }
  });

  test("a non-flat all-negative window with no anchor renders zero at the top edge with all data below it", () => {

    using dom = createTestDom();

    // Spanning -5 to 0: y(-1) = 64 - ((4 / 5) * 57) = 18.40, y(-5) = 64.00, y(-3) = 64 - ((2 / 5) * 57) = 41.20, and zero is at 7.00.
    const { hairline, line } = marksOf(createSparkline({ points: [ -1, -5, -3 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,18.40 L300.00,64.00 L592.00,41.20", "the negative window scales across the full plot height");
    assert.equal(hairline.getAttribute("y1"), "7.00", "zero renders at the domain's top edge");

    for(const { y } of coordinatesOf(line)) {

      assert.ok(y > 7, "every sample renders below the zero hairline");
    }
  });

  test("domainAnchor floors the domain top so low data renders low", () => {

    using dom = createTestDom();

    // The anchor raises the top from 1 to 14, so the flat series draws near the floor: y(1) = 64 - ((1 / 14) * 57) = 59.93.
    const { line } = marksOf(createSparkline({ domainAnchor: 14, points: [ 1, 1, 1 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,59.93 L300.00,59.93 L592.00,59.93", "a flat low series sits near the bottom of an anchored domain");
  });

  test("domainAnchor never clips data above it", () => {

    using dom = createTestDom();

    // The data maximum of 20 exceeds the anchor of 14, so the domain follows the data: y(20) = 7.00 and y(1) = 64 - ((1 / 20) * 57) = 61.15.
    const { line } = marksOf(createSparkline({ domainAnchor: 14, points: [ 1, 20 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,61.15 L592.00,7.00", "the spike scales to the data maximum rather than clipping at the anchor");
  });

  test("the end dot takes the last point's coordinates", () => {

    using dom = createTestDom();

    const { dot } = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(dot.getAttribute("cx"), "592.00", "the newest sample sits at the plot's right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot takes the last sample's y");
    assert.equal(dot.getAttribute("visibility"), "visible", "a populated window shows its dot");
  });

  test("an empty window clears both paths and hides the dot", () => {

    using dom = createTestDom();

    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [] }).element);

    assert.equal(line.getAttribute("d"), "", "no window means no line");
    assert.equal(area.getAttribute("d"), "", "no window means no area");
    assert.equal(dot.getAttribute("visibility"), "hidden", "the dot hides rather than stranding itself at the last window's position");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "there is no zero to mark");
  });

  test("a one-point window renders the lone dot at the plot's right edge with empty paths", () => {

    using dom = createTestDom();

    // A single sample spans 0 to 5, so it lands at the domain's top: y(5) = 64 - 57 = 7.00.
    const { area, dot, line } = marksOf(createSparkline({ points: [5] }).element);

    assert.equal(line.getAttribute("d"), "", "one sample draws no line");
    assert.equal(area.getAttribute("d"), "", "one sample draws no area");
    assert.equal(dot.getAttribute("cx"), "592.00", "the lone sample is the newest sample, at the right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the lone sample takes its own value's y");
    assert.equal(dot.getAttribute("visibility"), "visible", "one sample is still something to show");
  });

  test("a flat all-zero window lands every point on the baseline", () => {

    using dom = createTestDom();

    // The only window whose domain collapses. The guarded span of 1 puts every value at y = 64 - ((0 / 1) * 57) = 64.00.
    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [ 0, 0, 0 ] }).element);

    assert.equal(line.getAttribute("d"), "M8.00,64.00 L300.00,64.00 L592.00,64.00", "a collapsed domain lands on the baseline, not at NaN");
    assert.equal(area.getAttribute("d"), "M8.00,64.00 L300.00,64.00 L592.00,64.00 L592.00,64.00 L8.00,64.00 Z", "the area closes at the same baseline");
    assert.equal(dot.getAttribute("cy"), "64.00", "the dot lands on the baseline too");
    assert.equal(hairline.getAttribute("visibility"), "hidden", "an all-zero window never dips below zero");
  });

  test("non-finite points are filtered before any geometry is computed", () => {

    using dom = createTestDom();

    const filtered = marksOf(createSparkline({ points: [ 1, NaN, 2, Infinity, 3, "4" ] }).element);
    const clean = marksOf(createSparkline({ points: [ 1, 2, 3 ] }).element);

    assert.equal(filtered.line.getAttribute("d"), clean.line.getAttribute("d"), "the hostile window renders exactly as the same window without its junk");
    assert.equal(filtered.area.getAttribute("d"), clean.area.getAttribute("d"), "the area matches too");
    assert.equal(filtered.dot.getAttribute("cy"), "7.00", "the dot takes the last finite sample");
  });

  test("a non-finite domainAnchor is ignored", () => {

    using dom = createTestDom();

    const anchored = marksOf(createSparkline({ domainAnchor: NaN, points: [ 1, 2, 3 ] }).element);

    assert.equal(anchored.line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "a NaN anchor leaves the data's own domain in place");
  });
});

describe("createSparkline - color discipline", () => {

  test("every mark draws in currentColor at the fixed opacities, with the dot ringed in the surface token", () => {

    using dom = createTestDom();

    const { area, dot, hairline, line } = marksOf(createSparkline({ points: [ -1, 2 ] }).element);

    assert.equal(line.getAttribute("stroke"), "currentColor", "the line inherits the surrounding color");
    assert.equal(line.getAttribute("fill"), "none", "the line is a stroke, not a shape");
    assert.equal(line.getAttribute("stroke-width"), "2", "the line carries the fixed weight");
    assert.equal(line.getAttribute("vector-effect"), "non-scaling-stroke", "the line keeps its weight through the viewBox stretch");
    assert.equal(area.getAttribute("fill"), "currentColor", "the area inherits the same color as the line");
    assert.equal(area.getAttribute("fill-opacity"), "0.12", "the area reads as a tint rather than a second color statement");
    assert.equal(area.getAttribute("stroke"), "none", "the area is a fill, not a stroke");
    assert.equal(dot.getAttribute("fill"), "currentColor", "the dot inherits the same color");
    assert.equal(dot.getAttribute("r"), "4", "the dot carries the fixed radius");
    assert.equal(dot.getAttribute("stroke"), "var(--fo-surface-bg, Canvas)", "the dot's ring reads as a punch-out of the page surface");
    assert.equal(dot.getAttribute("stroke-width"), "2", "the ring carries the fixed width");
    assert.equal(hairline.getAttribute("stroke"), "currentColor", "the hairline is a faint tint of the data's own color");
    assert.equal(hairline.getAttribute("stroke-opacity"), "0.4", "the hairline carries the fixed opacity");
    assert.equal(hairline.getAttribute("stroke-width"), "1", "the hairline is a hairline");
  });
});

describe("createSparkline - updating in place", () => {

  test("update repaints the very same element and marks", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const before = marksOf(sparkline.element);

    sparkline.update({ points: [ 2, 3, 4 ] });

    const after = marksOf(sparkline.element);

    assert.ok(after.area === before.area, "the area path is the same element across updates");
    assert.ok(after.dot === before.dot, "the dot is the same element across updates");
    assert.ok(after.group === before.group, "the sliding group is the same element across updates");
    assert.ok(after.hairline === before.hairline, "the hairline is the same element across updates");
    assert.ok(after.line === before.line, "the line path is the same element across updates");
  });

  test("a plain update genuinely recomputes the geometry", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const { dot, line } = marksOf(sparkline.element);

    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the starting window renders as hand-computed");
    assert.equal(dot.getAttribute("cy"), "7.00", "the starting dot takes the last sample");

    // A four-point window steps by 584 / 3 = 194.67, and it spans 0 to 4, so y = 64 - ((value / 4) * 57): 49.75, 35.50, 21.25, 7.00.
    sparkline.update({ points: [ 1, 2, 3, 4 ] });

    assert.equal(line.getAttribute("d"), "M8.00,49.75 L202.67,35.50 L397.33,21.25 L592.00,7.00", "both the spacing and the scale are recomputed");
    assert.equal(dot.getAttribute("cx"), "592.00", "the newest sample still sits at the plot's right edge");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot follows the new last sample");

    // Dropping to a two-point window spanning 0 to 40 moves every y: y(30) = 64 - ((30 / 40) * 57) = 21.25 and y(40) = 7.00.
    sparkline.update({ points: [ 30, 40 ] });

    assert.equal(line.getAttribute("d"), "M8.00,21.25 L592.00,7.00", "a shorter window rescales rather than reusing the prior geometry");
    assert.equal(dot.getAttribute("cy"), "7.00", "the dot takes the new maximum");
  });

  test("an update from an empty window brings the dot back", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [] });
    const { dot } = marksOf(sparkline.element);

    assert.equal(dot.getAttribute("visibility"), "hidden", "an empty strip starts with no dot");
    assert.equal(dot.getAttribute("cx"), null, "an empty strip never positioned its dot");

    sparkline.update({ points: [ 1, 2, 3 ] });

    assert.equal(dot.getAttribute("visibility"), "visible", "the dot returns with the data");
    assert.equal(dot.getAttribute("cx"), "592.00", "and takes its position at the right edge");
  });

  test("the strip is an image with a live accessible label", () => {

    using dom = createTestDom();

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

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 1, 2, 3 ] });
    const { dot, line } = marksOf(sparkline.element);

    sparkline.update({ points: null });

    assert.equal(line.getAttribute("d"), "", "a null window clears the line");
    assert.equal(dot.getAttribute("visibility"), "hidden", "a null window hides the dot");
  });

  test("the construction entry point normalizes its window the same way update does", () => {

    using dom = createTestDom();

    const empty = marksOf(createSparkline({ points: null }).element);

    assert.equal(empty.line.getAttribute("d"), "", "a null construction window renders the empty state");
    assert.equal(empty.dot.getAttribute("visibility"), "hidden", "a null construction window hides the dot");

    const hostile = createSparkline({ points: [ NaN, 1, 2, Infinity, 3 ] });

    assert.equal(marksOf(hostile.element).line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "a NaN-bearing construction window is filtered first");

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

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { dot, group, line } = marksOf(sparkline.element);

    // Virtual time throughout the slide cases that leave a slide in flight, so the fallback timer this arms is discarded at teardown rather than outliving the test.
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the group carries the fixed duration and easing");
      assert.equal(group.style.transform, "translateX(-292.00px)", "the group travels exactly one window step");

      // The union is the outgoing 10 plus the new window, drawn at the settled window's own step of 292 - so it reaches one step past the plot's right edge - and
      // scaled on the union's own domain of 0 to 10, where y = 64 - ((value / 10) * 57): 7.00, 58.30, 52.60, 46.90.
      const union = coordinatesOf(line);

      assert.equal(union.length, 4, "the union carries the outgoing sample alongside the new window");
      assert.equal(union[0].x, 8, "the union starts at the plot's left edge");
      assert.equal(union[3].x, 884, "the incoming sample waits one step beyond the plot's right edge");
      assert.equal(union[3].y, 46.9, "the union is scaled on the union's own domain, not the new window's");
      assert.equal(union[0].y, 7, "the outgoing extreme still sets the top of that shared domain");
      assert.equal(dot.getAttribute("cx"), "884.00", "the dot follows the incoming sample in from beyond the edge");
    } finally {

      mock.timers.reset();
    }
  });

  test("a transitionend on the group settles the slide", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the settled group carries no transform");
    assert.equal(group.style.transition, "", "the settled group carries no transition");
    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the settled strip carries the plain new window");
  });

  test("the fallback timer settles the slide when no transitionend arrives", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transform, "translateX(-292.00px)", "the slide is under way before the clock advances");

      // The fallback fires one margin past the slide's nominal end: 400 + 60.
      mock.timers.tick(460);

      assert.equal(group.style.transform, "", "the fallback cleared the transform");
      assert.equal(group.style.transition, "", "the fallback cleared the transition");
      assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the fallback painted the plain new window");
    } finally {

      mock.timers.reset();
    }
  });

  test("a transitionend from a child or for another property does not settle the slide", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    dispatchTransitionEnd({ target: line });

    assert.equal(group.style.transform, "translateX(-292.00px)", "a child's transition must not cut the slide short");

    dispatchTransitionEnd({ propertyName: "opacity", target: group });

    assert.equal(group.style.transform, "translateX(-292.00px)", "another property's transition must not cut the slide short");

    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the group's own transform transition does settle it");
  });

  test("settling on transitionend cancels the fallback timer outright", () => {

    using dom = createTestDom();

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

    using dom = createTestDom();

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

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    assert.equal(group.style.transform, "translateX(-292.00px)", "the first cycle animates");

    dispatchTransitionEnd({ target: group });

    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the first cycle settles on its window");

    sparkline.update({ points: [ 2, 3, 4 ], slide: true });

    assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the second cycle re-arms the transition");
    assert.equal(group.style.transform, "translateX(-292.00px)", "the second cycle animates by the same one step");

    // The second union is 1, 2, 3, 4 on a domain of 0 to 4, where y = 64 - ((value / 4) * 57): 49.75, 35.50, 21.25, 7.00.
    assert.equal(line.getAttribute("d"), "M8.00,49.75 L300.00,35.50 L592.00,21.25 L884.00,7.00", "the second union is drawn on its own shared domain");

    dispatchTransitionEnd({ target: group });

    assert.equal(group.style.transform, "", "the second cycle settles clean");
    assert.equal(line.getAttribute("d"), "M8.00,35.50 L300.00,21.25 L592.00,7.00", "the second cycle settles on its window");
  });

  test("an update arriving mid-slide cancels the pending settle and wins", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });
      sparkline.update({ points: [ 30, 40 ] });

      assert.equal(group.style.transform, "", "the newer window clears the abandoned slide's transform");
      assert.equal(group.style.transition, "", "the newer window clears the abandoned slide's transition");
      assert.equal(line.getAttribute("d"), "M8.00,21.25 L592.00,7.00", "the newer window is what renders");

      // Neither abandoned mechanism may land on top of the newer window.
      dispatchTransitionEnd({ target: group });
      mock.timers.tick(1000);

      assert.equal(line.getAttribute("d"), "M8.00,21.25 L592.00,7.00", "the abandoned slide never repaints over the newer window");
    } finally {

      mock.timers.reset();
    }
  });

  test("an update arriving mid-slide applies instantly even when it asks to slide", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    sparkline.update({ points: [ 2, 3, 4 ], slide: true });

    assert.equal(group.style.transition, "", "no second transition arms mid-cycle");
    assert.equal(group.style.transform, "", "the group is left parked, not part-way through a transform");
    assert.equal(line.getAttribute("d"), "M8.00,35.50 L300.00,21.25 L592.00,7.00", "the newest window renders immediately");
  });

  test("a detached element settles harmlessly", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    document.body.append(sparkline.element);
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    sparkline.element.remove();

    assert.doesNotThrow(() => dispatchTransitionEnd({ target: group }), "settling a detached strip throws nothing");
    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the detached strip still holds its settled geometry");
  });

  test("a window that is not a one-step shift repaints instantly", () => {

    using dom = createTestDom();

    // Every mismatch shape: shifted by two, shorter, longer, and - the case that actually convicts an endpoint-only comparison - a window whose first element
    // matches the previous window's second while its interior differs. The shifted-by-two fixture already mismatches at the first overlap, so only the
    // interior-corruption row proves the shape check reads every overlapping element rather than the endpoints alone.
    const cases = [

      { expected: "M8.00,35.50 L202.67,26.00 L397.33,16.50 L592.00,7.00", label: "shifted by two", points: [ 3, 4, 5, 6 ], start: [ 1, 2, 3, 4 ] },
      { expected: "M8.00,26.00 L592.00,7.00", label: "shorter", points: [ 2, 3 ], start: [ 1, 2, 3 ] },
      { expected: "M8.00,49.75 L202.67,35.50 L397.33,21.25 L592.00,7.00", label: "longer", points: [ 1, 2, 3, 4 ], start: [ 1, 2, 3 ] },
      { expected: "M8.00,51.33 L202.67,7.00 L397.33,7.00 L592.00,32.33", label: "interior corruption behind a matching first overlap", points: [ 2, 9, 9, 5 ],
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

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group, line } = marksOf(sparkline.element);

    stubMatchMedia(true);
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    assert.equal(group.style.transition, "", "a preference set after construction still suppresses the animation");
    assert.equal(group.style.transform, "", "the group never moves under reduced motion");
    assert.equal(line.getAttribute("d"), "M8.00,45.00 L300.00,26.00 L592.00,7.00", "the new window is painted instantly instead");
  });

  test("a host without matchMedia reads as no preference and slides", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group } = marksOf(sparkline.element);

    window.matchMedia = undefined;
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "the absent reader is no preference, so the slide proceeds");
      assert.equal(group.style.transform, "translateX(-292.00px)", "and the group travels its one step");
    } finally {

      mock.timers.reset();
    }
  });

  test("a host reporting no reduced-motion preference slides", () => {

    using dom = createTestDom();

    const sparkline = createSparkline({ points: [ 10, 1, 2 ] });
    const { group } = marksOf(sparkline.element);

    stubMatchMedia(false);
    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(group.style.transition, "transform 400ms cubic-bezier(0.25, 0.1, 0.25, 1)", "an explicit no-preference host animates");
      assert.equal(group.style.transform, "translateX(-292.00px)", "and the group travels its one step");
    } finally {

      mock.timers.reset();
    }
  });
});

describe("createSparkline - scrubbing", () => {

  test("a pointer maps through the element's offset box to the nearest sample", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // x(250) = 300 and round((300 - 8) / 292) = 1. A mapping that ignored the box's left edge would read 250 / 300 * 600 = 500, index 2.
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 1, value: 2 }], "the callback is handed the middle sample, once");
    assert.equal(cursorLine.getAttribute("x1"), "300.00", "the cursor line sits on the middle sample rather than between samples");
    assert.equal(cursorLine.getAttribute("x2"), "300.00", "the cursor line is vertical");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line shows while the pointer is over the strip");
    assert.equal(cursorDot.getAttribute("cx"), "300.00", "the cursor dot shares the line's x");
    assert.equal(cursorDot.getAttribute("cy"), "26.00", "the cursor dot sits on the data line at the sample's own y");
    assert.equal(cursorDot.getAttribute("visibility"), "visible", "the cursor dot shows with the line");
  });

  test("the box's width scales the pointer into viewBox units", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // x(350) = 500 and round((500 - 8) / 292) = 2. Unscaled, the mapping would read round(((350 - 100) - 8) / 292) = 1.
    dispatchPointer({ clientX: 350, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 2, value: 3 }], "the callback is handed the newest sample");
    assert.equal(cursorLine.getAttribute("x1"), "592.00", "the cursor line sits on the newest sample at the plot's right edge");
    assert.equal(cursorDot.getAttribute("cy"), "7.00", "the cursor dot takes the newest sample's y");
  });

  test("a pointer beyond the plot's left or right edge clamps to the sample at that edge", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // x(0) = -200, a raw index of round(-0.71) = -1, and x(500) = 800, a raw index of round(2.71) = 3.
    dispatchPointer({ clientX: 0, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 0, value: 1 }], "a pointer left of the plot reads the oldest sample");
    assert.equal(cursorLine.getAttribute("x1"), "8.00", "the cursor line sits on the oldest sample");
    assert.equal(cursorDot.getAttribute("cy"), "45.00", "the cursor dot takes the oldest sample's y");

    dispatchPointer({ clientX: 500, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [ { index: 0, value: 1 }, { index: 2, value: 3 } ], "a pointer right of the plot reads the newest sample, once");
    assert.equal(cursorLine.getAttribute("x1"), "592.00", "the cursor line sits on the newest sample");
  });

  test("a pointer resolves from the plot's left edge, so one just short of the first midpoint reads the oldest sample", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorLine } = marksOf(sparkline.element);

    // x(175) = 150, and round((150 - 8) / 292) = round(0.49) = 0, the oldest sample at x 8. A read that ignored the left inset would take round(150 / 292) =
    // round(0.51) = 1.
    dispatchPointer({ clientX: 175, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 0, value: 1 }], "the pointer is measured from the plot's left edge, not the viewBox's");
    assert.equal(cursorLine.getAttribute("x1"), "8.00", "the cursor line sits on the oldest sample");
  });

  test("an anchored strip's cursor dot sits on the line under the anchored domain", () => {

    using dom = createTestDom();

    const { sparkline } = scrubbableSparkline({ domainAnchor: 14 });
    const { cursorDot, line } = marksOf(sparkline.element);

    // The anchor raises the domain's top from 3 to 14, so the middle sample draws low: y(2) = 64 - ((2 / 14) * 57) = 55.86, where the data's own domain of 0 to 3
    // would put it at 26.00.
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.equal(coordinatesOf(line)[1].y, 55.86, "the line's middle vertex sits on the anchored domain");
    assert.equal(cursorDot.getAttribute("cx"), "300.00", "the cursor dot sits on the middle sample");
    assert.equal(cursorDot.getAttribute("cy"), "55.86", "the cursor dot takes the anchored domain the line is drawn on, not the data's own");
  });

  test("a move reports only on reaching a different sample, and a leave withdraws the sample once", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // x(260) = 320, and round((320 - 8) / 292) is still 1.
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    dispatchPointer({ clientX: 260, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 1, value: 2 }], "repeated moves over one sample report it once");

    dispatchPointer({ target: sparkline.element, type: "pointerleave" });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, null ], "a leave withdraws the sample with null");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line hides on leave");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot hides on leave");

    dispatchPointer({ target: sparkline.element, type: "pointerleave" });
    dispatchPointer({ target: sparkline.element, type: "pointercancel" });

    assert.equal(onScrub.mock.callCount(), 2, "a second leave and a cancel after it have nothing left to withdraw");
  });

  test("a press resolves and reports like a move", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorLine } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointerdown" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 1, value: 2 }], "a touch reads a sample the moment it lands");
    assert.equal(cursorLine.getAttribute("x1"), "300.00", "the cursor line sits on the pressed sample");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line shows on press");
  });

  test("a cancel withdraws the sample like a leave", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    dispatchPointer({ target: sparkline.element, type: "pointercancel" });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, null ], "a gesture the browser takes over ends the scrub with null");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line hides on cancel");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot hides on cancel");
  });

  test("a repaint under a held pointer always reports, even at an unchanged index", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    // For the window 1, 5, 3 the domain is 0 to 5, so the new middle value lands at the top: y(5) = 64 - 57 = 7.00.
    sparkline.update({ points: [ 1, 5, 3 ] });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, { index: 1, value: 5 } ], "the held index reports its new value");
    assert.equal(cursorDot.getAttribute("cy"), "7.00", "the cursor dot moves to the new value");

    // Advancing the window 1, 2, 2 by a sample yields 2, 2, 3, which puts the sample that was third at the held index, carrying the same value, so only a repaint
    // that always reports tells the consumer its readout describes a different sample.
    const slid = scrubbableSparkline({ points: [ 1, 2, 2 ] });

    dispatchPointer({ clientX: 250, target: slid.sparkline.element, type: "pointermove" });
    slid.sparkline.update({ points: [ 2, 2, 3 ] });

    assert.deepEqual(reportsOf(slid.onScrub), [ { index: 1, value: 2 }, { index: 1, value: 2 } ], "a slid-in sample at the held index reports again");
  });

  test("a repaint that resizes the window resolves the held position rather than the held index", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // x(260) = 320, which the three-point window reads as round((320 - 8) / 292) = round(1.07) = 1. The held x sits off every midpoint of both windows, so the
    // case depends on the geometry alone and never on which way a rounding tie falls.
    dispatchPointer({ clientX: 260, target: sparkline.element, type: "pointermove" });

    // A four-point window steps by 584 / 3 = 194.67, so for the held x of 320, round((320 - 8) / 194.67) = round(1.60) = 2, at x 397.33; its domain is 0 to 4,
    // where y(3) = 64 - ((3 / 4) * 57) = 21.25.
    sparkline.update({ points: [ 1, 2, 3, 4 ] });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, { index: 2, value: 3 } ], "the pointer's position, not its old index, picks the sample");
    assert.equal(cursorLine.getAttribute("x1"), "397.33", "the cursor line follows the resized spacing");
    assert.equal(cursorDot.getAttribute("cy"), "21.25", "the cursor dot takes the new sample's y on the new scale");
  });

  test("a held pointer survives an emptied window: the cursor hides, the sample is withdrawn, and the data's return reports it again", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    sparkline.update({ points: [] });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, null ], "an emptied window withdraws the sample");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line hides with the data");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot hides with the data");

    // The pointer never left, so the strip keeps its position through the empty window and resolves it again the moment data returns.
    sparkline.update({ points: [ 1, 2, 3 ] });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, null, { index: 1, value: 2 } ], "the returning data reports the sample under the held pointer");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line returns with the data");
    assert.equal(cursorDot.getAttribute("visibility"), "visible", "the cursor dot returns with the data");
  });

  test("a slide under a held pointer hides the cursor and holds the report until transitionend settles it", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [ 10, 1, 2 ] });
    const { cursorDot, cursorLine, group } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    assert.deepEqual(reportsOf(onScrub), [{ index: 1, value: 1 }], "nothing is reported while the slide is in flight");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line steps aside for the slide");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot steps aside for the slide");

    dispatchTransitionEnd({ target: group });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 1 }, { index: 1, value: 2 } ], "the settle reports the sample the window landed under the pointer");
    assert.equal(cursorLine.getAttribute("x1"), "300.00", "the cursor line returns on the settled sample");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line shows again");
    assert.equal(cursorDot.getAttribute("cy"), "26.00", "the cursor dot sits on the settled window's line");
  });

  test("a slide settled by the fallback timer reports the held pointer's sample", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [ 10, 1, 2 ] });
    const { cursorLine } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      assert.equal(onScrub.mock.callCount(), 1, "nothing is reported before the clock advances");

      mock.timers.tick(460);

      assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 1 }, { index: 1, value: 2 } ], "the fallback settle reports the landed sample");
      assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line returns with the fallback settle");
    } finally {

      mock.timers.reset();
    }
  });

  test("a leave mid-slide withdraws the sample at once, and the settle reports nothing", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [ 10, 1, 2 ] });
    const { cursorLine, group } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    sparkline.update({ points: [ 1, 2, 3 ], slide: true });
    dispatchPointer({ target: sparkline.element, type: "pointerleave" });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 1 }, null ], "the leave is reported without waiting for the slide");

    dispatchTransitionEnd({ target: group });

    assert.equal(onScrub.mock.callCount(), 2, "the settle finds no pointer and nothing to withdraw");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor stays hidden after the settle");
  });

  test("a move mid-slide reports nothing and keeps the cursor hidden, and the settle reports the sample it resolves to", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [ 10, 1, 2 ] });
    const { cursorDot, cursorLine, group } = marksOf(sparkline.element);

    sparkline.update({ points: [ 1, 2, 3 ], slide: true });

    // At x(350) = 500 the pointer is over index 2 of the settled window, but the data is part-way through a translation the cursor does not follow, so the move
    // only records where the pointer is.
    dispatchPointer({ clientX: 350, target: sparkline.element, type: "pointermove" });

    assert.equal(onScrub.mock.callCount(), 0, "a move during a slide reports nothing");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line stays hidden while the data moves");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot stays hidden while the data moves");

    dispatchTransitionEnd({ target: group });

    assert.deepEqual(reportsOf(onScrub), [{ index: 2, value: 3 }], "the settle reports the sample under the pointer that moved mid-slide");
    assert.equal(cursorLine.getAttribute("x1"), "592.00", "the cursor line lands on the newest sample");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line shows once the slide settles");
    assert.equal(cursorDot.getAttribute("visibility"), "visible", "the cursor dot shows once the slide settles");
  });

  test("an update mid-slide resolves the held pointer once against the newer window", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [ 10, 1, 2 ] });
    const { cursorDot, cursorLine, group } = marksOf(sparkline.element);

    mock.timers.enable({ apis: ["setTimeout"] });

    try {

      // x(260) = 320, index 1 of the three-point window, and off every midpoint of both windows so the case never rests on a rounding tie.
      dispatchPointer({ clientX: 260, target: sparkline.element, type: "pointermove" });
      sparkline.update({ points: [ 1, 2, 3 ], slide: true });

      // The two-point window steps by 584, so for the held x of 320, round((320 - 8) / 584) = round(0.53) = 1; its domain is 0 to 40, where y(40) = 7.00.
      sparkline.update({ points: [ 30, 40 ] });

      assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 1 }, { index: 1, value: 40 } ], "the newer window's sample is reported");
      assert.equal(cursorLine.getAttribute("x1"), "592.00", "the cursor line sits on the newer window's sample");
      assert.equal(cursorDot.getAttribute("cy"), "7.00", "the cursor dot sits on the newer window's line");

      // Neither abandoned settle mechanism may report over the newer window.
      dispatchTransitionEnd({ target: group });
      mock.timers.tick(1000);

      assert.equal(onScrub.mock.callCount(), 2, "the abandoned slide reports nothing");
    } finally {

      mock.timers.reset();
    }
  });

  test("a one-sample window resolves to index 0 at the plot's right edge", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [5] });
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    // A lone sample's domain is 0 to 5, so y(5) = 64 - 57 = 7.00, and it sits at the plot's right edge.
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [{ index: 0, value: 5 }], "a lone sample is the only one to report");
    assert.equal(cursorLine.getAttribute("x1"), "592.00", "the cursor line sits where the lone sample's dot does");
    assert.equal(cursorDot.getAttribute("cx"), "592.00", "the cursor dot lands on the end dot");
    assert.equal(cursorDot.getAttribute("cy"), "7.00", "the cursor dot takes the lone sample's y");
  });

  test("a box with no width clears the pointer and withdraws a reported sample", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    sparkline.element.getBoundingClientRect = () => ({ left: 100, width: 0 });
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.deepEqual(reportsOf(onScrub), [ { index: 1, value: 2 }, null ], "a strip with no width has no sample under any pointer");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line hides");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot hides");
  });

  test("a move before any window is painted hides the cursor and reports nothing", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [] });
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.equal(onScrub.mock.callCount(), 0, "an empty strip has no sample to report");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line stays hidden");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot stays hidden");
  });

  test("a throwing callback finds the scrub's state recorded and its marks placed before the call", () => {

    using dom = createTestDom();

    const { onScrub, sparkline } = scrubbableSparkline({ points: [] });
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    onScrub.mock.mockImplementation(() => {

      throw new Error("The consumer's readout failed.");
    });

    // Happy-DOM reports a listener's throw as an error event rather than rethrowing it, so the throw is driven through update instead: the pointer is held over
    // the empty strip, and the data's arrival resolves it inside the update call.
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });

    assert.throws(() => sparkline.update({ points: [ 1, 2, 3 ] }), { message: "The consumer's readout failed." }, "the callback's throw propagates through the update");
    assert.equal(cursorLine.getAttribute("x1"), "300.00", "the cursor line was placed on the resolved sample before the call");
    assert.equal(cursorLine.getAttribute("visibility"), "visible", "the cursor line was shown before the call");
    assert.equal(cursorDot.getAttribute("visibility"), "visible", "the cursor dot was shown before the call");

    // At x(260) = 320 the pointer is still over index 1, so a strip that recorded the report before the call has nothing new to hand over.
    dispatchPointer({ clientX: 260, target: sparkline.element, type: "pointermove" });

    assert.equal(onScrub.mock.callCount(), 1, "the report was recorded before the call, so a move over the same sample makes no second call");
  });

  test("a detached element under a held pointer reports nothing on repaint", () => {

    using dom = createTestDom();

    // A strip that never reached the page: the pointer is held, and no repaint may report a sample for a strip nobody can see.
    const onScrub = mock.fn();
    const sparkline = createSparkline({ onScrub, points: [ 1, 2, 3 ] });
    const { cursorDot, cursorLine } = marksOf(sparkline.element);

    sparkline.element.getBoundingClientRect = () => SCRUB_RECT;
    dispatchPointer({ clientX: 250, target: sparkline.element, type: "pointermove" });
    sparkline.update({ points: [ 2, 3, 4 ] });

    assert.equal(onScrub.mock.callCount(), 0, "a detached strip reports nothing");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line stays hidden off the page");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot stays hidden off the page");

    // A strip removed from the page after reporting withdraws that sample once on the next repaint, and reports nothing on the repaints after it.
    const removed = scrubbableSparkline();

    dispatchPointer({ clientX: 250, target: removed.sparkline.element, type: "pointermove" });
    removed.sparkline.element.remove();
    removed.sparkline.update({ points: [ 2, 3, 4 ] });
    removed.sparkline.update({ points: [ 3, 4, 5 ] });

    assert.deepEqual(reportsOf(removed.onScrub), [ { index: 1, value: 2 }, null ], "the removed strip withdraws its sample and reports nothing after");
    assert.equal(marksOf(removed.sparkline.element).cursorLine.getAttribute("visibility"), "hidden", "the removed strip's cursor hides");

    // A browser sends no leave to a removed element, so the position the strip held is dropped while it is off the page: back on the page with no pointer
    // over it, a repaint shows no cursor and reports nothing until a pointer arrives.
    document.body.append(removed.sparkline.element);
    removed.sparkline.update({ points: [ 4, 5, 6 ] });

    assert.equal(removed.onScrub.mock.callCount(), 2, "the reattached strip reports nothing for the position dropped off the page");
    assert.equal(marksOf(removed.sparkline.element).cursorLine.getAttribute("visibility"), "hidden", "the reattached strip's cursor line stays hidden");
    assert.equal(marksOf(removed.sparkline.element).cursorDot.getAttribute("visibility"), "hidden", "the reattached strip's cursor dot stays hidden");
  });

  test("a strip built without a callback carries no cursor, no touch rule and no pointer response", () => {

    using dom = createTestDom();

    const { element } = createSparkline({ points: [ 1, 2, 3 ] });
    const { cursorDot, cursorLine } = marksOf(element);

    element.getBoundingClientRect = () => SCRUB_RECT;
    document.body.append(element);

    const before = element.outerHTML;

    assert.equal(element.children.length, 2, "the element holds the hairline and the sliding group alone");
    assert.equal(cursorLine, undefined, "no cursor line is built");
    assert.equal(cursorDot, undefined, "no cursor dot is built");
    assert.equal(element.style.touchAction, "", "no touch rule is set, so every gesture stays the page's");
    assert.doesNotThrow(() => dispatchPointer({ clientX: 250, target: element, type: "pointermove" }), "a move over an unwired strip throws nothing");
    assert.equal(element.outerHTML, before, "a move over an unwired strip changes nothing");

    // Only a function wires the scrub, so any other value builds the same unwired strip.
    assert.equal(createSparkline({ onScrub: null, points: [ 1, 2, 3 ] }).element.children.length, 2, "a null callback wires nothing");
  });

  test("the cursor marks draw in currentColor with the dot ringed in the surface token, and the touch rule leaves vertical scrolling to the page", () => {

    using dom = createTestDom();

    const { sparkline } = scrubbableSparkline();
    const { cursorDot, cursorLine, group } = marksOf(sparkline.element);

    assert.equal(sparkline.element.children.length, 4, "the cursor marks are the element's own children, after the sliding group");
    assert.equal(group.children.length, 3, "the sliding group carries the data marks alone, so the cursor never translates with the data");
    assert.equal(cursorLine.getAttribute("stroke"), "currentColor", "the cursor line inherits the surrounding color");
    assert.equal(cursorLine.getAttribute("stroke-opacity"), "0.6", "the cursor line carries its own fixed opacity");
    assert.equal(cursorLine.getAttribute("stroke-width"), "1", "the cursor line carries the hairline's width");
    assert.equal(cursorLine.getAttribute("vector-effect"), "non-scaling-stroke", "the cursor line keeps its weight through the viewBox stretch");
    assert.equal(cursorLine.getAttribute("y1"), "0", "the cursor line starts at the top edge");
    assert.equal(cursorLine.getAttribute("y2"), "64", "the cursor line ends at the bottom edge");
    assert.equal(cursorLine.getAttribute("visibility"), "hidden", "the cursor line starts hidden");
    assert.equal(cursorDot.getAttribute("fill"), "currentColor", "the cursor dot inherits the same color");
    assert.equal(cursorDot.getAttribute("r"), "4", "the cursor dot carries the end dot's radius");
    assert.equal(cursorDot.getAttribute("stroke"), "var(--fo-surface-bg, Canvas)", "the cursor dot's ring reads as a punch-out of the page surface");
    assert.equal(cursorDot.getAttribute("stroke-width"), "2", "the cursor dot's ring carries the end dot's ring width");
    assert.equal(cursorDot.getAttribute("visibility"), "hidden", "the cursor dot starts hidden");
    assert.equal(sparkline.element.style.touchAction, "pan-y pinch-zoom", "a horizontal drag scrubs while a vertical one scrolls and a pinch zooms");
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
