export default [
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                fetch: 'readonly',
                AbortController: 'readonly',
                indexedDB: 'readonly',
                IDBDatabase: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                performance: 'readonly',
                HTMLElement: 'readonly',
                ResizeObserver: 'readonly',
                // SillyTavern globals
                toastr: 'readonly',
                jQuery: 'readonly',
                $: 'readonly',
                SillyTavern: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'eqeqeq': ['warn', 'smart'],
            'no-var': 'error',
            'no-debugger': 'warn',
            'no-duplicate-imports': 'warn',
        },
    },
    {
        files: ['test/**/*.mjs'],
        rules: {
            'no-unused-vars': 'off',
        },
    },
    {
        ignores: ['core/**', 'node_modules/**'],
    },
];
