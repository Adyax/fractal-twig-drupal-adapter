'use strict';

const Fractal = require('@frctl/fractal');
const _ = require('lodash');
const fs = require('fs');
const Path = require('path');
const utils = Fractal.utils;

class TwigAdapter extends Fractal.Adapter {

    constructor(Twig, source, app, config) {

        super(Twig, source);
        this._app = app;
        this._config = config;

        let self = this;

        Twig.extend(function(Twig) {

            /*
             * Register a Fractal template loader. Locations can be handles or paths.
             */

            Twig.Templates.registerLoader('fractal', function(location, params, callback, errorCallback) {

                if (params.precompiled) {
                    params.data = params.precompiled;
                    return new Twig.Template(params);
                }

                let view = findView(location, source.fullPath);

                if (!view) {
                    throw new Error(`Template ${location} not found`);
                }

                params.data = view.content;

                return new Twig.Template(params);
            });

            /*
             * Monkey patch the render method to make sure that the _self variable
             * always refers to the actual component/sub-component being rendered.
             * Without this _self would always refer to the root component.
             */

            const render = Twig.Template.prototype.render;
            Twig.Template.prototype.render = function(context, params) {

                if (self._config.pristine && !this.id) {
                  return;
                }
                else {
                  let attributes = new AttributesObject();

                  let component_id = `${Path.parse(this.id).name.replace(/^_/, '').replace(/^\d\d\-/, '')}`;

                  if(!component_id.startsWith('@')) {
                      component_id = `@${component_id}`;
                  }

                  let entity = source.find(component_id);

                  entity = entity.isVariant ? entity : entity.variants().default();

                  context.attributes = attributes;

                  context = utils.defaultsDeep(_.cloneDeep(context), entity.getContext());

                  context._self = entity.toJSON();

                  let yaml_context = render_yaml(context._self.context, context, context);

                  setKeys(yaml_context);
                }

                /*
                 * Twig JS uses an internal _keys property on the context data
                 * which we need to regenerate every time we patch the context.
                 */

                function setKeys(obj) {

                    obj._keys = _.compact(_.map(obj, (val, key) => {
                        return (_.isString(key) && ! key.startsWith('_')) ? key : undefined;
                    }));
                    _.each(obj, (val, key) => {
                        if (_.isPlainObject(val) && (_.isString(key) && ! key.startsWith('_'))) {
                            setKeys(val);
                        }
                    });
                }

                return render.call(this, context, params);
            };

            /*
             * Twig caching is enabled for better perf, so we need to
             * manually update the cache when a template is updated or removed.
             */

            Twig.cache = false;

            self.on('view:updated', unCache);
            self.on('view:removed', unCache);
            self.on('wrapper:updated', unCache);
            self.on('wrapper:removed', unCache);

            function unCache(view) {
                let path = Path.relative(source.fullPath, _.isString(view) ? view : view.path);
                if (view.handle && Twig.Templates.registry[view.handle]) {
                    delete Twig.Templates.registry[view.handle];
                }
                if (Twig.Templates.registry[path]) {
                    delete Twig.Templates.registry[path];
                }
            }

        });

        function isHandle(str) {
            return str && str.startsWith(self._config.handlePrefix);
        }

        function _preparePaths(location, sourcePath) {
            let basename = Path.basename(location);
            let paths = [];
            // @handle/custom-twig
            paths.push(location);
            // @handle/custom-twig/collection--variant => @handle/collection--variant
            paths.push(self._config.handlePrefix + basename);
            // path/to/custom-twig.twig
            paths.push(Path.join(sourcePath, location));
            // @handle/onto/path/to/file.twig => absolute/path/to/file.twig
            paths.push(Path.join(sourcePath, location.replace(self._config.handlePrefix, '')));
            // @handle/to/collection => absolute/path/to/collection/collection.twig
            paths.push(Path.join(sourcePath, location.replace(self._config.handlePrefix, ''), basename + '.twig'));

            return paths;
        }

        function findView(location, sourcePath) {
            let paths = _preparePaths(location, sourcePath);
            let view;

            for (let i = 0; i < paths.length; i++) {
                view = _.find(self.views, function (view) {
                    if (view.handle === paths[i]) {
                        return true;
                    }

                    return view.path === paths[i];
                });

                if (view) {
                    return view;
                }
            }

            // include plain files like svg
            for (let i = 0; i < paths.length; i++) {
                if (fs.existsSync(paths[i])) {
                    view = {
                        'content': fs.readFileSync(paths[i], 'utf8')
                    };
                }
            }

            return view;
        }

        function AttributesObject() {
          let self = this;
          this.classes = '';
          this.attr = [];
        
          this.addClass = function(...str) {
              self.classes = _.flatten(str).join(' ');
              return self;
          };
        
          this.removeClass = function(...str) {
              return self;
          };
        
          this.setAttribute = function(attribute, value) {
              let str = `${attribute}="${value}"`;
        
              self.attr.push(str);
              self.attr = _.uniq(self.attr);
        
              return self;
          };
        }
        
        AttributesObject.prototype.toString = function toString() {
          let attrList = [
              this.classes ? `class="${this.classes}"` : '',
              this.attr ? this.attr.join(' ') : '',
          ];
        
          return attrList.join(' ');
        };
        
        function render_yaml(context_yaml, old_context_yaml, main_context) {
          for (let key in context_yaml) {
              let type = typeof context_yaml[key];
              let item_id;
              if(type === 'object' || type === 'array') {
                  render_yaml(context_yaml[key], old_context_yaml[key], main_context);
              }
              else if (type === 'string') {
                  if(context_yaml[key].startsWith('$')) {
                    let context_yaml_split = context_yaml[key].split(',');
                    context_yaml[key] = '';
                    old_context_yaml[key] = '';
                    context_yaml_split.forEach((item) => {
                      let isAttr = false;
                      let rendered_elem;
                      if(item !== '$create_attributes()') {
                          item_id = item.trim().replace('$', '@');
                          let entity = source.find(item_id);
                          entity = entity.isVariant ? entity : entity.variants().default();
                          let new_context = utils.defaultsDeep(entity.getContext(), _.cloneDeep(main_context));
                          new_context.attributes = new AttributesObject();
                          new_context._self = entity.toJSON();
        
                          let template = self.engine.twig({
                              method: 'fractal',
                              async: false,
                              rethrow: true,
                              name: item_id
                          });
        
                          rendered_elem = template.render(new_context);
                      }
                      else {
                          isAttr = true;
                          rendered_elem = new AttributesObject();
                      }
                      if(isAttr) {
                          context_yaml[key] = rendered_elem;
                      }
                      else {
                          context_yaml[key] = context_yaml[key] + rendered_elem;
                      }
                      old_context_yaml[key] = context_yaml[key];
                    });
                  }
              }
          }
          return old_context_yaml;
        }
    }

    get twig() {
        return this._engine;
    }

    render(path, str, context, meta) {
        let self = this;

        meta = meta || {};

        if (!this._config.pristine) {
            setEnv('_self', meta.self, context);
            setEnv('_target', meta.target, context);
            setEnv('_env', meta.env, context);
            setEnv('_config', this._app.config(), context);
            setEnv('title_prefix', '', context);
            setEnv('title_suffix', '', context);
        }

        return new Promise(function(resolve, reject){

            let tplPath = Path.relative(self._source.fullPath, path);

            try {
                let template = self.engine.twig({
                    method: 'fractal',
                    async: false,
                    rethrow: true,
                    name: meta.self ? `${self._config.handlePrefix}${meta.self.handle}` : tplPath,
                    precompiled: str
                });
                resolve(template.render(context));
            } catch (e) {
                reject(new Error(e));
            }

        });

        function setEnv(key, value, context) {
            if (value !== undefined) {
                context[key] = value;
            }
        }
    }

}

module.exports = function(config) {

    config = _.defaults(config || {}, {
        pristine: false,
        handlePrefix: '@',
        importContext: false
    });

    return {

        register(source, app) {

            const Twig = require('twig');

            if (!config.pristine) {
                _.each(require('./functions')(app) || {}, function(func, name){
                    Twig.extendFunction(name, func);
                });
                _.each(require('./filters')(app), function(filter, name){
                    Twig.extendFilter(name, filter);
                });
                _.each(require('./tests')(app), function(test, name){
                    Twig.extendTest(name, test);
                });
                Twig.extend(function(Twig) {
                    _.each(require('./tags')(app), function(tag){
                        Twig.exports.extendTag(tag(Twig));
                    });
                });
            }

            _.each(config.functions || {}, function(func, name){
                Twig.extendFunction(name, func);
            });
            _.each(config.filters || {}, function(filter, name){
                Twig.extendFilter(name, filter);
            });
            _.each(config.tests || {}, function(test, name){
                Twig.extendTest(name, test);
            });
            Twig.extend(function(Twig) {
                _.each(config.tags || {}, function(tag){
                    Twig.exports.extendTag(tag(Twig));
                });
            });

            const adapter = new TwigAdapter(Twig, source, app, config);

            adapter.setHandlePrefix(config.handlePrefix);

            return adapter;
        }
    }

};