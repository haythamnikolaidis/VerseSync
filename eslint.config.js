'use strict';

module.exports = [
  // Verbatim copy of VerseFlow's parser, used as a Python test fixture; not our code to lint.
  { ignores: ['tests/fixtures/verseflow/**'] },
  {
    files: ['panel/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        CSInterface: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      'no-var': 'off',
      strict: 'off'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly'
      }
    }
  }
];
