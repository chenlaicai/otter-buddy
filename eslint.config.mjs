import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Clean Architecture layer dependency rules (D30-D42)
 *
 * Dependency direction (outer -> inner):
 *   frameworks/ -> interface-adapters/ -> usecases/ -> entities/
 *
 * Rules:
 * - entities/: no imports from usecases, interface-adapters, or frameworks (except @frameworks/logger per D39)
 * - usecases/: no imports from interface-adapters or frameworks (except @frameworks/logger per D39)
 * - interface-adapters/: no imports from frameworks
 * - frameworks/: no restrictions (may import from all inner layers)
 * - main.ts: Composition Root, exempt from all layer restrictions
 *
 * Cross-cutting exemption (D39): @frameworks/logger is allowed in entities/ and usecases/.
 * Config (D40): @frameworks/config is NOT exempt — must be injected via main.ts.
 */

/** Frameworks modules restricted from inner layers (everything except logger) */
const restrictedFrameworks = [
  // Alias imports
  "@frameworks/db/**", "@frameworks/llm/**", "@frameworks/embedding/**",
  "@frameworks/agent/**", "@frameworks/web/**", "@frameworks/config",
  // Relative imports (any depth)
  "**/frameworks/db/**", "**/frameworks/llm/**", "**/frameworks/embedding/**",
  "**/frameworks/agent/**", "**/frameworks/web/**", "**/frameworks/config",
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".claude/**", ".snail/**", ".git/**", "logs/**", "docs/**", "reference/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "complexity": ["error", 12],
      "max-depth": ["error", 4],
      "max-lines": ["error", { max: 450, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 5],
      "max-statements": ["error", 25],
      "no-console": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  // Layer 1: entities/ — cannot import from any outer layer (except @frameworks/logger per D39)
  {
    files: ["src/entities/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@usecases/**", "@interface-adapters/**", "**/usecases/**", "**/interface-adapters/**"],
            message: "Entities layer cannot import from usecases or interface-adapters"
          },
          {
            group: restrictedFrameworks,
            message: "Entities layer cannot import from frameworks (except @frameworks/logger per D39)"
          }
        ]
      }]
    }
  },
  // Layer 2: usecases/ — cannot import from interface-adapters or frameworks (except @frameworks/logger per D39)
  {
    files: ["src/usecases/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@interface-adapters/**", "**/interface-adapters/**"],
            message: "Use cases layer cannot import from interface-adapters"
          },
          {
            group: restrictedFrameworks,
            message: "Use cases layer cannot import from frameworks (except @frameworks/logger per D39)"
          }
        ]
      }]
    }
  },
  // Layer 3: interface-adapters/ — cannot import from frameworks at all
  {
    files: ["src/interface-adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@frameworks/**", "**/frameworks/**"],
            message: "Interface adapters layer cannot import from frameworks"
          }
        ]
      }]
    }
  },
  // Composition Root: main.ts exempt from layer restrictions
  {
    files: ["src/main.ts"],
    rules: {
      "no-restricted-imports": "off"
    }
  },
  // Test rules
  {
    files: ["tests/**/*.ts"],
    rules: {
      "complexity": ["error", 20],
      "max-lines-per-function": ["error", { max: 220, skipBlankLines: true, skipComments: true }],
      "max-statements": ["error", 140],
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": ["error",
        { selector: "CallExpression[callee.property.name='toHaveBeenCalledWith']", message: "禁止断言调用参数--绑定实现细节。使用返回值/状态/副作用断言替代。" },
        { selector: "CallExpression[callee.property.name='toBeCalledTimes']", message: "禁止断言调用次数--绑定实现细节。使用返回值/状态/副作用断言替代。" },
        { selector: "CallExpression[callee.property.name='toHaveBeenCalledTimes']", message: "禁止断言调用次数--绑定实现细节。使用返回值/状态/副作用断言替代。" }
      ]
    }
  }
);
