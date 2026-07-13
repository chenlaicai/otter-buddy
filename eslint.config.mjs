import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".claude/**", ".snail/**", ".git/**", "logs/**", "docs/**"],
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
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["*/_internal/*"]
      }]
    }
  },
  {
    files: ["src/main.ts"],
    rules: {
      "no-restricted-imports": "off"
    }
  }
);
