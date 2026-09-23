/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-svg.test.mjs: Unit tests for the webUI's SVG element builder.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSvgElement } from "./webUi-svg.mjs";
import { createTestDom } from "./ui.helpers.mjs";

describe("createSvgElement", () => {

  test("builds the element in the SVG namespace, which is what makes the browser draw it", () => {

    using dom = createTestDom();

    const element = createSvgElement({ tag: "path" });

    assert.equal(element.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(element.localName, "path");
    assert.equal(element.attributes.length, 0, "no attributes were asked for, so none are set");
  });

  test("applies every attribute as an attribute, keeping its name exactly as written", () => {

    using dom = createTestDom();

    const element = createSvgElement({ attributes: { "d": "M0 0L16 16", "stroke-width": "2", "viewBox": "0 0 16 16" }, tag: "svg" });

    assert.equal(element.getAttribute("d"), "M0 0L16 16");
    assert.equal(element.getAttribute("stroke-width"), "2", "a dashed presentation attribute is set as written");
    assert.equal(element.getAttribute("viewBox"), "0 0 16 16", "and a mixed-case one keeps its case");
  });
});
