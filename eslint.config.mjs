import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
        "no-unused-vars": "off",
        "@typescript-eslint/no-unused-vars": ["error", {
            args: "after-used",
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrors: "none",
        }],
    },
}];