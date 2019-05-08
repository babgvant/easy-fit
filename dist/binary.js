'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.addEndian = addEndian;
exports.readRecord = readRecord;
exports.getArrayBuffer = getArrayBuffer;
exports.calculateCRC = calculateCRC;

var _fit = require('./fit');

var _messages = require('./messages');

function addEndian(littleEndian, bytes) {
    var result = 0;
    if (!littleEndian) bytes.reverse();
    for (var i = 0; i < bytes.length; i++) {
        result += bytes[i] << (i << 3) >>> 0;
    }

    return result;
}

var timestamp = 0;
var lastTimeOffset = 0;
var CompressedTimeMask = 31;
var CompressedLocalMesgNumMask = 0x60;
var CompressedHeaderMask = 0x80;

function readData(blob, fDef, startIndex) {
    if (fDef.endianAbility === true) {
        var temp = [];
        for (var i = 0; i < fDef.size; i++) {
            temp.push(blob[startIndex + i]);
        }
        var uint32Rep = addEndian(fDef.littleEndian, temp);

        if (fDef.type === 'sint32') {
            return uint32Rep >> 0;
        }

        return uint32Rep;
    }

    if (fDef.type === 'string') {
        var _temp = [];
        for (var _i = 0; _i < fDef.size; _i++) {
            if (blob[startIndex + _i]) {
                _temp.push(blob[startIndex + _i]);
            }
        }
        return new Buffer(_temp).toString('utf-8');
    }

    return blob[startIndex];
}

function formatByType(data, type, scale, offset) {
    switch (type) {
        case 'date_time':
            timestamp = data;
            lastTimeOffset = timestamp & CompressedTimeMask;
            return new Date(data * 1000 + 631065600000);
        case 'left_right_balance':
            return { 'right': data & 127, 'left': 100 - (data & 127) };
        case 'left_right_balance_100':
            return { 'right': (data & 16383) / 100, 'left': 100 - (data & 16383) / 100 };
        case 'sint32':
        case 'sint16':
            return data * _fit.FIT.scConst;
        case 'uint32':
        case 'uint16':
            return scale ? data / scale + offset : data;
        default:
            if (_fit.FIT.types[type]) {
                return _fit.FIT.types[type][data];
            }
            return data;
    }
}

function isInvalidValue(data, type) {
    var retVal = false;

    switch (type) {
        case 'enum':
            retVal = data === 0xFF;
            break;
        case 'sint8':
            retVal = data === 0x7F;
            break;
        case 'uint8':
            retVal = data === 0xFF;
            break;
        case 'sint16':
            retVal = data === 0x7FFF;
            break;
        case 'left_right_balance_100':
        case 'uint16':
            retVal = data === 0xFFFF;
            break;
        case 'sint32':
            retVal = data === 0x7FFFFFFF;
            break;
        case 'uint32':
            retVal = data === 0xFFFFFFFF;
            break;
        case 'string':
            retVal = data === 0x00;
            break;
        case 'float32':
            retVal = data === 0xFFFFFFFF;
            break;
        case 'float64':
            retVal = data === 0xFFFFFFFFFFFFFFFF;
            break;
        case 'uint8z':
            retVal = data === 0x00;
            break;
        case 'uint16z':
            retVal = data === 0x0000;
            break;
        case 'uint32z':
            retVal = data === 0x000000;
            break;
        case 'left_right_balance':
        case 'byte':
            retVal = data === 0xFF;
            break;
        case 'sint64':
            retVal = data === 0x7FFFFFFFFFFFFFFF;
            break;
        case 'uint64':
            retVal = data === 0xFFFFFFFFFFFFFFFF;
            break;
        case 'uint64z':
            retVal = data === 0x0000000000000000;
            break;
    }

    return retVal;
}

function convertTo(data, unitsList, speedUnit) {
    var unitObj = _fit.FIT.options[unitsList][speedUnit];
    return unitObj ? data * unitObj.multiplier + unitObj.offset : data;
}

function applyOptions(data, field, options) {
    switch (field) {
        case 'speed':
        case 'enhanced_speed':
        case 'vertical_speed':
        case 'avg_speed':
        case 'max_speed':
        case 'speed_1s':
        case 'ball_speed':
        case 'enhanced_avg_speed':
        case 'enhanced_max_speed':
        case 'avg_pos_vertical_speed':
        case 'max_pos_vertical_speed':
        case 'avg_neg_vertical_speed':
        case 'max_neg_vertical_speed':
            return convertTo(data, 'speedUnits', options.speedUnit);
        case 'distance':
        case 'total_distance':
        case 'enhanced_avg_altitude':
        case 'enhanced_min_altitude':
        case 'enhanced_max_altitude':
        case 'enhanced_altitude':
        case 'height':
        case 'odometer':
        case 'avg_stroke_distance':
        case 'min_altitude':
        case 'avg_altitude':
        case 'max_altitude':
        case 'total_ascent':
        case 'total_descent':
        case 'altitude':
        case 'cycle_length':
        case 'auto_wheelsize':
        case 'custom_wheelsize':
        case 'gps_accuracy':
            return convertTo(data, 'lengthUnits', options.lengthUnit);
        case 'temperature':
        case 'avg_temperature':
        case 'max_temperature':
            return convertTo(data, 'temperatureUnits', options.temperatureUnit);
        default:
            return data;
    }
}

function readRecord(blob, messageTypes, developerFields, startIndex, options, startDate) {
    var recordHeader = blob[startIndex];
    var localMessageType = recordHeader & 15;

    if ((recordHeader & CompressedHeaderMask) === CompressedHeaderMask) {
        //compressed timestamp

        var timeoffset = recordHeader & CompressedTimeMask;
        timestamp += timeoffset - lastTimeOffset & CompressedTimeMask;
        lastTimeOffset = timeoffset;

        localMessageType = (recordHeader & CompressedLocalMesgNumMask) >> 5;
    } else if ((recordHeader & 64) === 64) {
        // is definition message
        // startIndex + 1 is reserved

        var hasDeveloperData = (recordHeader & 32) === 32;
        var lEnd = blob[startIndex + 2] === 0;
        var numberOfFields = blob[startIndex + 5];
        var numberOfDeveloperDataFields = hasDeveloperData ? blob[startIndex + 5 + numberOfFields * 3 + 1] : 0;

        var mTypeDef = {
            littleEndian: lEnd,
            globalMessageNumber: addEndian(lEnd, [blob[startIndex + 3], blob[startIndex + 4]]),
            numberOfFields: numberOfFields + numberOfDeveloperDataFields,
            fieldDefs: []
        };

        var _message = (0, _messages.getFitMessage)(mTypeDef.globalMessageNumber);

        for (var i = 0; i < numberOfFields; i++) {
            var fDefIndex = startIndex + 6 + i * 3;
            var baseType = blob[fDefIndex + 2];

            var _message$getAttribute = _message.getAttributes(blob[fDefIndex]),
                field = _message$getAttribute.field,
                type = _message$getAttribute.type;

            var fDef = {
                type: type,
                fDefNo: blob[fDefIndex],
                size: blob[fDefIndex + 1],
                endianAbility: (baseType & 128) === 128,
                littleEndian: lEnd,
                baseTypeNo: baseType & 15,
                name: field,
                dataType: (0, _messages.getFitMessageBaseType)(baseType & 15)
            };

            mTypeDef.fieldDefs.push(fDef);
        }

        for (var _i2 = 0; _i2 < numberOfDeveloperDataFields; _i2++) {
            var _fDefIndex = startIndex + 6 + numberOfFields * 3 + 1 + _i2 * 3;

            var fieldNum = blob[_fDefIndex];
            var size = blob[_fDefIndex + 1];
            var devDataIndex = blob[_fDefIndex + 2];

            var devDef = developerFields[devDataIndex][fieldNum];

            var _baseType = devDef.fit_base_type_id;

            var _fDef = {
                type: _fit.FIT.types.fit_base_type[_baseType],
                fDefNo: fieldNum,
                size: size,
                endianAbility: (_baseType & 128) === 128,
                littleEndian: lEnd,
                baseTypeNo: _baseType & 15,
                name: devDef.field_name,
                dataType: (0, _messages.getFitMessageBaseType)(_baseType & 15),
                isDeveloperField: true
            };

            mTypeDef.fieldDefs.push(_fDef);
        }

        messageTypes[localMessageType] = mTypeDef;

        var nextIndex = startIndex + 6 + mTypeDef.numberOfFields * 3;
        var nextIndexWithDeveloperData = nextIndex + 1;

        return {
            messageType: 'definition',
            nextIndex: hasDeveloperData ? nextIndexWithDeveloperData : nextIndex
        };
    }

    var messageType = messageTypes[localMessageType] || messageTypes[0];

    // TODO: handle compressed header ((recordHeader & 128) == 128)

    // uncompressed header
    var messageSize = 0;
    var readDataFromIndex = startIndex + 1;
    var fields = {};
    var message = (0, _messages.getFitMessage)(messageType.globalMessageNumber);

    for (var _i3 = 0; _i3 < messageType.fieldDefs.length; _i3++) {
        var _fDef2 = messageType.fieldDefs[_i3];
        var data = readData(blob, _fDef2, readDataFromIndex);

        if (!isInvalidValue(data, _fDef2.type)) {
            if (_fDef2.isDeveloperField) {
                // Skip format of data if developer field
                fields[_fDef2.name] = data;
            } else {
                var _message$getAttribute2 = message.getAttributes(_fDef2.fDefNo),
                    field = _message$getAttribute2.field,
                    type = _message$getAttribute2.type,
                    scale = _message$getAttribute2.scale,
                    offset = _message$getAttribute2.offset;

                if (field !== 'unknown' && field !== '' && field !== undefined) {
                    fields[field] = applyOptions(formatByType(data, type, scale, offset), field, options);
                }
            }

            if (message.name === 'record' && options.elapsedRecordField) {
                fields.elapsed_time = (fields.timestamp - startDate) / 1000;
            }
        }

        readDataFromIndex += _fDef2.size;
        messageSize += _fDef2.size;
    }

    if (message.name === 'field_description') {
        developerFields[fields.developer_data_index] = developerFields[fields.developer_data_index] || [];
        developerFields[fields.developer_data_index][fields.field_definition_number] = fields;
    }

    var result = {
        messageType: message.name,
        nextIndex: startIndex + messageSize + 1,
        message: fields
    };

    return result;
}

function getArrayBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) {
        return buffer;
    }
    var ab = new ArrayBuffer(buffer.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buffer.length; ++i) {
        view[i] = buffer[i];
    }
    return ab;
}

function calculateCRC(blob, start, end) {
    var crcTable = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];

    var crc = 0;
    for (var i = start; i < end; i++) {
        var byte = blob[i];
        var tmp = crcTable[crc & 0xF];
        crc = crc >> 4 & 0x0FFF;
        crc = crc ^ tmp ^ crcTable[byte & 0xF];
        tmp = crcTable[crc & 0xF];
        crc = crc >> 4 & 0x0FFF;
        crc = crc ^ tmp ^ crcTable[byte >> 4 & 0xF];
    }

    return crc;
}