import js from "@eslint/js"
import globals from "globals"
import react from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"

export default [
    { ignores: ["dist"] },
    js.configs.recommended,
    react.configs.flat.recommended,
    react.configs.flat["jsx-runtime"],
    {
        files: ["**/*.{js,jsx}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: { ...globals.browser },
        },
        settings: { react: { version: "detect" } },
        plugins: { "react-hooks": reactHooks },
        rules: {
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
            // no PropTypes anywhere, and apostrophes in copy are fine
            "react/prop-types": "off",
            "react/no-unescaped-entities": "off",
        },
    },
    {
        files: ["**/*.test.js", "vite.config.js", "eslint.config.js"],
        languageOptions: { globals: { ...globals.node } },
    },
]
