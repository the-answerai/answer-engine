module.exports = {
  extends: ['../../.eslintrc.json'],
  parserOptions: {
    project: './tsconfig.lint.json',
    tsconfigRootDir: __dirname,
  },
};
