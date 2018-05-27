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

        this.drupal_settings = [];
        this.preview = false;
        this.opened_ID_current = null;
        this.opened_ID_main = null;
        this.cached_drupal_settings = [];
        this.isChildRender = false;

        let self = this;

        Twig.extend(function(Twig) {

            /*
             * Register a Fractal template loader. Locations can be handles or paths.
             */

            Twig.Templates.registerLoader('fractal', function(location, params, callback, errorCallback) {

                if (params.precompiled) {
                    if(params.id == '@preview--default') {
                      self.preview = true;
                    }
                    else {
                      self.opened_ID_current = params.id;
                      self.opened_ID_main = params.id;
                    }
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

                  context = utils.defaultsDeep(_.cloneDeep(context), _.cloneDeep(entity.getContext()));

                  context._self = entity.toJSON();

                  let yaml_context = render_yaml(context._self.context, context, context, self.opened_ID_current);

                  if(self.preview === true) {

                    let settings_output;

                    if(self.isChildRender === false && self.cached_drupal_settings[self.opened_ID_main] !== undefined) {
                      settings_output = self.cached_drupal_settings[self.opened_ID_main];
                    }

                    else if(self.isChildRender === true) {
                      self.cached_drupal_settings[self.opened_ID_main] = drupal_settings_converter(self.drupal_settings);
                      settings_output = self.cached_drupal_settings[self.opened_ID_main]
                    }

                    else if(self.isChildRender === false) {
                      settings_output = drupal_settings_converter(self.drupal_settings);
                    }

                    self.isChildRender = false;
                    yaml_context.drupal_settings_global = settings_output;
                    self.drupal_settings.length = 0;
                    self.opened_ID_main = null;

                  }

                  if(self.opened_ID_current === component_id) {
                    self.opened_ID_current = null;
                  }

                  setKeys(yaml_context);

                  self.preview = false;
                }

                /*
                 * Twig JS uses an internal _keys property on the context data
                 * which we need to regenerate every time we patch the context.
                 */

                function setKeys(obj) {

                    obj._keys = _.compact(_.map(obj, (val, key) => {
                        if(key !== 'drupal_settings_global') {
                          return (_.isString(key) && ! key.startsWith('_')) ? key : undefined;
                        }
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

        class AttributesObject extends Array {
          constructor(it) {
            super(it);
            let self = this;
            self.classes = {};
            self.attr = {};

            this.addClass = (...str) => {
              let classesArr = _.flatten(str);
              classesArr.forEach((item) => {
                self.classes[item] = true;
              });
              return self;
            }

            this.removeClass = (...str) => {
              let classesArr = _.flatten(str);
              classesArr.forEach((item) => {
                if(self.classes[item] !== undefined) {
                  delete self.classes[item];
                }
              });
              return self;
            }

            this.hasClass = (className) => {
              return !! self.classes[className];
            }

            this.removeAttribute = (attribute) => {
              if(self.attr[attribute] !== undefined) {
                delete self.attr[attribute]
              }
              return self;
            }

            this.setAttribute = (attribute, value) => {
              this.attr[attribute] = value;
              return self;
            }

            this.toString = () => {
              let classes_string = '';
              let attr_string = '';
              let output;

              for(let key in self.classes) {
                classes_string = `${classes_string} ${key}`;
              }

              for(let key in self.attr) {
                attr_string = `${attr_string} ${key}="${self.attr[key]}"`;
              }

              output = classes_string.length !== 0 ? `class="${classes_string.trim()}"` : '';
              output = attr_string.length !== 0  ? `${output} ${attr_string}` : output;

              return output.trim();
            }
          }
        }

        function fill_attributes_object_from_context(attr_object) {
          let attributes = new AttributesObject();
          for (let key in attr_object) {
            if(key === 'classes') {
              let classes_array;
              if(typeof attr_object[key] === 'string') {
                attributes.addClass(attr_object[key]);
              }
              else {
                attr_object[key].forEach((class_name) => {
                  attributes.addClass(class_name.trim());
                });
              }
            }
            else {
              attributes.setAttribute(key, attr_object[key]);
            }
          }
          return attributes;
        }
        
        function render_yaml(context_yaml, old_context_yaml, main_context, opened_ID) {
          for (let key in context_yaml) {
              let type = typeof context_yaml[key];
              let item_id;
              if(key === 'attributes' && context_yaml[key] !== '$create_attributes()') {
                context_yaml[key] = fill_attributes_object_from_context(context_yaml[key]);
                old_context_yaml[key] = context_yaml[key];
              }
              else if((key === 'drupal_settings') && (type === 'object' || type === 'array')) {
                self.drupal_settings.push(context_yaml[key]);
              }
              else if(type === 'object' || type === 'array') {
                  render_yaml(context_yaml[key], old_context_yaml[key], main_context, opened_ID);
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
                          let new_context = utils.defaultsDeep(_.cloneDeep(entity.getContext(), _.cloneDeep(main_context));
                          new_context.attributes = new AttributesObject();
                          new_context._self = entity.toJSON();
        
                          let template = self.engine.twig({
                              method: 'fractal',
                              async: false,
                              rethrow: true,
                              name: item_id
                          });
        
                          rendered_elem = template.render(new_context);
                          if(opened_ID !== null) {
                            self.isChildRender = true;
                          }
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

        function drupal_settings_converter(settings_context) {
          let settings_output = {};
          if(settings_context.length === 0) {
            return;
          }
          settings_context.forEach((item) => {
            if(item !== null) {
              for(let key in item) {
                if(item[key] !== null || key !== '_keys') {
                  if(item[key].fractal_id !== undefined) {
                    if(settings_output.hasOwnProperty(key) === false) {
                      settings_output[key] = {};
                    }
                    settings_output[key][item[key].fractal_id] = item[key];
                  }
                  else {
                    settings_output[key] = item[key];
                  }
                }
              }
            }
          });
          return `<script>
            window.drupalSettings = ${JSON.stringify(settings_output, (key, value) => {
              return key === 'fractal_id' || value === null ? undefined : value; 
            })}
          </script>`;
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