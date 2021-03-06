var Promise = require('bluebird');
var path = require('path');
var retry = require('bluebird-retry');
var expect = require('chai').expect;
var _ = require('underscore');
var Elasticsearch = require('elasticsearch');
var AmazonElasticsearchClient = require('aws-es2');
var uuid = require('uuid');
var util = require('util');

var juttle_test_utils = require('juttle/test').utils;

var check_juttle = juttle_test_utils.check_juttle;
var configureAdapter = juttle_test_utils.configureAdapter;

var AWS_HOST = 'search-dave-6jy2cskdfaye4ji6gfa6x375ve.us-west-2.es.amazonaws.com';
var AWS_REGION = 'us-west-2';
var TEST_RUN_ID = uuid.v4().substring(0, 8);

var LOCAL = 'local';
var AWS = 'aws';

var mode = process.env.TESTMODE;
var modes;
if (mode === 'all') {
    modes = [LOCAL, AWS];
} else if (mode === 'aws') {
    modes = [AWS];
} else {
    modes = [LOCAL];
}

var local_client = Promise.promisifyAll(new Elasticsearch.Client({
    host: 'localhost:9200'
}));
Promise.promisifyAll(local_client.indices);

var test_index = 'my_index';
var has_index_id = 'has_default_index';
var has_default_type_id = 'has_default_type';
var aws_has_default_type_id = 'aws_has_default_type';

var config = [
    {
        id: LOCAL,
        address: 'localhost',
        port: 9200
    },
    {
        id: 'b',
        address: 'localhost',
        port: 9999 // b's config is botched so we get errors reading from it
    },
    {
        id: has_index_id,
        address: 'localhost',
        port: 9200,
        index: test_index
    },
    {
        id: has_default_type_id,
        address: 'localhost',
        port: 9200,
        type: 'my_test_type'
    }
];

var aws_client;
if (_.contains(modes, AWS)) {
    aws_client = Promise.promisifyAll(new AmazonElasticsearchClient({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        service: 'es',
        region: AWS_REGION,
        host: AWS_HOST
    }));

    Promise.promisifyAll(aws_client.indices);

    config.push({
        id: AWS,
        aws: true,
        endpoint: AWS_HOST,
        region: AWS_REGION
    });

    config.push({
        id: aws_has_default_type_id,
        aws: true,
        type: 'aws_default_type',
        endpoint: AWS_HOST,
        region: AWS_REGION
    });
}

config.path = path.resolve(__dirname, '..');
configureAdapter({elastic: config});

function _client_for_mode(mode) {
    return mode === 'aws' ? aws_client : local_client;
}

function _option_is_moment(key) {
    return key === 'from' || key === 'to' || key === 'lag';
}

function options_from_object(options) {
    return _.reduce(options, function(memo, value, key) {
        var str = _option_is_moment(key) ? ':%s:' : '"%s"';
        return memo + '-' + key + ' ' + util.format(str, value) + ' ';
    }, '');
}

function write(points, options, extra) {
    options = options || {};
    options = _.clone(options);
    options.index = options.index || TEST_RUN_ID;
    extra = extra || '';

    var opts = options_from_object(options);

    var program = 'emit -points %s | write elastic %s %s';
    var write_program = util.format(program, JSON.stringify(points), opts, extra);

    return check_juttle({
        program: write_program
    });
}

var DEFAULT_TEST_READ_OPTIONS = {
    from: '10 years ago',
    to: 'now',
    index: TEST_RUN_ID
};

function read(options, extra, deactivateAfter) {
    options = options || {};
    options = _.clone(options);
    _.defaults(options, DEFAULT_TEST_READ_OPTIONS);
    extra = extra || '';

    var opts = options_from_object(options);

    var program = 'read elastic %s %s';
    var read_program = util.format(program, opts, extra);

    return check_juttle({
        program: read_program,
        realtime: !!deactivateAfter,
        deactivateAfter: deactivateAfter
    });
}

function clear_data(mode, indexes) {
    indexes = indexes || TEST_RUN_ID + '*';
    var client = _client_for_mode(mode);
    return client.indices.deleteAsync({index: indexes});
}

function verify_import(points, mode, indexes, options) {
    options = options || {};
    var client = _client_for_mode(mode);
    var request_body = {
        index: indexes || TEST_RUN_ID + '*',
        type: '',
        body: {
            size: 10000
        }
    };

    if (options.timeField !== 'time') {
        points = points.map(function(pt) {
            var timeField = options.timeField || '@timestamp';
            pt = _.clone(pt);
            pt[timeField] = pt.time;
            delete pt.time;
            return pt;
        });
    }

    return retry(function() {
        return client.searchAsync(request_body)
        .then(function(body) {
            if (Array.isArray(body)) {
                body = body[0];
            }
            var received = body.hits.hits.map(function(doc) {
                return doc._source;
            });

            points.forEach(function(point) {
                var expected = _.clone(point);
                if (expected.time) {
                    expected.time = new Date(expected.time).toISOString();
                }
                // _.findWhere with deep equality
                var result = _.find(received, function(point) {
                    var keys = _.keys(expected);
                    return _.every(keys, function(key) {
                        return _.isEqual(point[key], expected[key]);
                    });
                });
                expect(result).exist;
            });
        });
    }, {max_tries: 10});
}

function expect_sorted(array) {
    for (var i = 0; i < array.length - 1; i++) {
        if (array[i].time > array[i+1].time) {
            throw new Error('points not sorted');
        }
    }
}

function check_result_vs_expected_sorting_by(received, expected, field) {
    // we have simultaneous points so time sort is not unique
    // so we make sure the result is sorted but verify the right result
    // with another sort
    expect_sorted(received);
    expect(_.sortBy(received, field)).deep.equal(_.sortBy(expected, field));
}

// only works on linear flowgraphs
function check_optimization(start, end, id, extra, options) {
    options = options || {};
    extra = extra || '';
    var opts = {from: start, to: end, id: id, index: options.index};
    var unoptimized_extra = '-optimize false ' + extra;

    return Promise.all([
        read(opts, extra),
        read(opts, unoptimized_extra)
    ])
    .spread(function(optimized, unoptimized) {
        var opt_data = optimized.sinks.table;
        var unopt_data = unoptimized.sinks.table;

        if (options.massage) {
            opt_data = options.massage(opt_data);
            unopt_data = options.massage(unopt_data);
        }

        expect(opt_data).deep.equal(unopt_data);
        return optimized;
    });
}

function list_indices() {
    return local_client.indices.getAliases()
        .then(function(result) {
            return Object.keys(result);
        });
}

function search(mode, index) {
    var client = _client_for_mode(mode);

    return client.searchAsync({
        index: index || '*',
        type: '',
        size: 10000,
        body: {}
    })
    .then(function(result) {
        if (Array.isArray(result)) {
            result = result[0];
        }

        return result;
    });
}

function expect_to_fail(promise, message) {
    return promise.throw(new Error('should have failed'))
        .catch(function(err) {
            expect(err.message).equal(message);
        });
}

function randInt(max) {
    return Math.floor(Math.random() * max);
}

// generates sample data for tests
// info is an object describing the data you want
// Possible keys for info:
// count: tells how many points you want to create, defaults to 10
// start: the timestamp of the earliest point you want to import
// interval: the interval between timestamps, in milliseconds
// tags: an object of the form {tagName1: [tag1Value1, tag1Value2...], tagName2: [tag2Value1,tag2value2,...]}
//     will create an equal number of points having each value for each tag (+/- 1 for divisibility)
function generate_sample_data(info) {
    info = info || {};
    var sampleData = [];

    var count = info.count || 10;
    var tags = info.tags || {name: ['test']};
    var interval = info.interval || 1;
    var date = (info.start) ? new Date(info.start) : new Date();

    for (var k = 0; k < count; k++) {
        var pointTags = {};

        _.each(tags, function(values, key) {
            pointTags[key] = values[k % values.length];
        });

        var sampleMetric = {
            time: date.toISOString(),
            value: randInt(100)
        };

        sampleData.push(_.extend(sampleMetric, pointTags));

        date.setTime(date.getTime() + interval);
    }

    return sampleData;
}

function check_no_write(write_promise, read_options) {
    function count() {
        return read(read_options, '| reduce count()');
    }

    var total, res;
    return count()
        .then(function(result) {
            total = result.sinks.table[0].count;
            return write_promise;
        })
        .then(function(result) {
            res = result;
            return count();
        })
        .then(function(result) {
            expect(result.sinks.table[0].count).equal(total);
            return res;
        });
}

function get_mapping(mode) {
    var options = {index: '*', type: ''};
    var client = _client_for_mode(mode);
    return client.indices.getMappingAsync(options)
        .spread(function(response, statusCode) {
            return response;
        });
}

function create_index(mode, index, body) {
    var options = {index: index, body: body};
    var client = _client_for_mode(mode);
    return client.indices.createAsync(options);
}

module.exports = {
    read: read,
    write: write,
    modes: modes,
    check_result_vs_expected_sorting_by: check_result_vs_expected_sorting_by,
    verify_import: verify_import,
    check_optimization: check_optimization,
    clear_data: clear_data,
    list_indices: list_indices,
    test_index: test_index,
    has_index_id: has_index_id,
    has_default_type: has_default_type_id,
    aws_has_default_type_id: aws_has_default_type_id,
    test_id: TEST_RUN_ID,
    search: search,
    expect_to_fail: expect_to_fail,
    generate_sample_data: generate_sample_data,
    check_no_write: check_no_write,
    get_mapping: get_mapping,
    create_index: create_index,
};
