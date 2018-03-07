# Twig Adapter

An adapter to let you use [Twig](https://github.com/twigjs/twig.js) templates with [Fractal](http://github.com/frctl/fractal).

## Installation

```bash
npm install --save-dev https://github.com/Adyax/fractal-twig-drupal-adapter.git
```

in your `fractal.js`

```js
const fractal = require('@frctl/fractal').create();
const twigAdapter = require('fractal-twig-drupal-adapter');
const twig = twigAdapter({
  handlePrefix: '@',
});
```
