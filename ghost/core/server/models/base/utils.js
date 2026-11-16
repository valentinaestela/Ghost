/**
 * # Utils
 * Parts of the model code which can be split out and unit tested
 */
const _ = require('lodash');

const ObjectId = require('bson-objectid').default;
const errors = require('@tryghost/errors');
const schema = require('../../data/schema');

/**
 * Attach wrapper (please never call attach manual!)
 *
 * We register the creating event to be able to hook into the model creation process of Bookshelf.
 * We need to load the model again, because of a known bookshelf issue:
 * see https://github.com/tgriesser/bookshelf/issues/629
 * (withRelated option causes a null value for the foreign key)
 *
 * roles [1,2]
 * roles [{id: 1}, {id: 2}]
 * roles [{role_id: 1}]
 * roles [BookshelfModel]
 */
const attach = function attach(Model, effectedModelId, relation, modelsToAttach, options) {
  options = options || {};

  let fetchedModel;
  const localOptions = { transacting: options.transacting };

  return Model.forge({ id: effectedModelId })
    .fetch(localOptions)
    .then(function successFetchedModel(_fetchedModel) {
      fetchedModel = _fetchedModel;

      if (!fetchedModel) {
        throw new errors.NotFoundError({ level: 'critical', help: effectedModelId });
      }

      fetchedModel.related(relation).on('creating', function (collection, data) {
        data.id = ObjectId().toHexString();
      });

      return Promise.resolve(modelsToAttach).then(function then(models) {
        models = _.map(models, function mapper(model) {
          if (model.id) {
            return model.id;
          } else if (!_.isObject(model)) {
            return model.toString();
          } else {
            return model;
          }
        });

        return fetchedModel.related(relation).attach(models, localOptions);
      });
    })
    .finally(function () {
      if (!fetchedModel) {
        return;
      }

      fetchedModel.related(relation).off('creating');
    });
};

const detach = function detach(Model, effectedModelId, relation, modelsToAttach, options) {
  options = options || {};

  let fetchedModel;
  const localOptions = { transacting: options.transacting };

  return Model.forge({ id: effectedModelId })
    .fetch(localOptions)
    .then(function successFetchedModel(_fetchedModel) {
      fetchedModel = _fetchedModel;

      if (!fetchedModel) {
        throw new errors.NotFoundError({ level: 'critical', help: effectedModelId });
      }

      return Promise.resolve(modelsToAttach).then(function then(models) {
        models = _.map(models, function mapper(model) {
          if (model.id) {
            return model.id;
          } else if (!_.isObject(model)) {
            return model.toString();
          } else {
            return model;
          }
        });

        return fetchedModel.related(relation).detach(models, localOptions);
      });
    });
};

/**
 * Cuts each of `columns` to its column's length, for text that comes from outside Ghost, such as a
 * name Stripe holds, which can be longer than the column. A value too long to store would fail the
 * save, and with it what Ghost was recording, such as a paid signup. The cut is by character
 * rather than UTF-16 unit, as the column counts them, so no character is cut in half.
 *
 * @param {{tableName: string, get(column: string): unknown, set(column: string, value: string): unknown}} model
 * @param {string[]} columns
 */
const fitToColumns = function fitToColumns(model, columns) {
  const table = schema.tables[model.tableName];
  for (const column of columns) {
    const value = model.get(column);
    if (typeof value === 'string') {
      model.set(column, Array.from(value).slice(0, table[column].maxlength).join(''));
    }
  }
};

module.exports.attach = attach;
module.exports.detach = detach;
module.exports.fitToColumns = fitToColumns;
