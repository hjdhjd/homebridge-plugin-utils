/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import hbPluginUtils from "./build/eslint-rules.mjs";

export default hbPluginUtils({

  allowDefaultProject: [ "build/*.@(js|mjs)", "eslint.config.mjs", "ui/*.@(js|mjs)" ],
  js: [ "build/**.mjs", "ui/**/*.@(js|mjs)", "eslint.config.mjs" ],
  ts: [ "src/**.ts", "src/ffmpeg/**.ts" ],
  ui: [ "ui/1.mjs", "ui/webUi.mjs", "ui/webUi-featureoptions.mjs" ]
});
