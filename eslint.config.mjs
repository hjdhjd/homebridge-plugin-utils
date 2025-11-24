/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * eslint.config.mjs: Linting defaults for Homebridge plugins.
 */
import eslintJs from "@eslint/js";
import hbPluginUtils from "./build/eslint-rules.mjs";
import ts from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";

export default ts.config(

  eslintJs.configs.recommended,

  {

    files: [ "src/**.ts", "src/ffmpeg/**.ts" ],
    rules: {

      ...hbPluginUtils.rules.ts
    }
  },

  {

    files: [ "build/**.mjs", "ui/**/*.@(js|mjs)", "eslint.config.mjs" ],
    rules: {

      ...hbPluginUtils.rules.js
    }
  },

  {

    files: [ "build/**.mjs", "src/**.ts", "src/ffmpeg/**.ts", "ui/**/*.@(js|mjs)", "eslint.config.mjs" ],

    ignores: ["dist"],

    languageOptions: {

      ecmaVersion: "latest",
      parser: tsParser,
      parserOptions: {

        ecmaVersion: "latest",

        projectService: {

          allowDefaultProject: [ "build/*.@(js|mjs)", "eslint.config.mjs", "ui/*.@(js|mjs)" ],
          defaultProject: "./tsconfig.json"
        }
      },

      sourceType: "module"
    },

    linterOptions: {

      reportUnusedDisableDirectives: "error"
    },

    plugins: {

      ...hbPluginUtils.plugins
    },

    rules: {

      ...hbPluginUtils.rules.common
    }
  },

  {

    files: [ "ui/1.mjs", "ui/webUi.mjs", "ui/webUi-featureoptions.mjs" ],

    languageOptions: {

      globals: {

        ...hbPluginUtils.globals.ui
      }
    }
  }
);

