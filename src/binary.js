import { FIT } from './fit';
import { getFitMessage, getFitMessageBaseType } from './messages';

export function addEndian(littleEndian, bytes) {
    let result = 0;
    if (!littleEndian) bytes.reverse();
    for (let i = 0; i < bytes.length; i++) {
        result += (bytes[i] << (i << 3)) >>> 0;
    }

    return result;
}

var timestamp = 0;
var lastTimeOffset = 0;
const CompressedTimeMask = 31;
const CompressedLocalMesgNumMask = 0x60;
const CompressedHeaderMask = 0x80;
const GarminTimeOffset = 631065600000;
let monitoring_timestamp = 0;

function readData(blob, fDef, startIndex) {
    if (fDef.endianAbility === true) {
        const temp = [];
        for (let i = 0; i < fDef.size; i++) {
            temp.push(blob[startIndex + i]);
        }
        const uint32Rep = addEndian(fDef.littleEndian, temp);

        if (fDef.type === 'sint32') {
            return (uint32Rep >> 0);
        }

        return uint32Rep;
    }

    if (fDef.type === 'string') {
        const temp = [];
        for (let i = 0; i < fDef.size; i++) {
            if (blob[startIndex + i]) {
                temp.push(blob[startIndex + i]);
            }
        }
        return new Buffer(temp).toString('utf-8');
    }

    return blob[startIndex];
}

function formatByType(data, type, scale, offset) {
    switch (type) {
        case 'date_time': 
            timestamp = data;
            lastTimeOffset = (timestamp & CompressedTimeMask);
            return new Date((data * 1000) + GarminTimeOffset);
        case 'left_right_balance':
            return { 'right': data & 127, 'left' : 100 - (data & 127) };
        case 'left_right_balance_100':
            return { 'right': (data & 16383) / 100, 'left' : 100 - ((data & 16383) / 100) };
        case 'sint32':
        case 'sint16':
            return data * FIT.scConst;
        case 'uint32':
        case 'uint16':
            return scale ? data / scale + offset : data;
        default:
            if (FIT.types[type]) {
                return FIT.types[type][data];
            }
            return data;
    }
}

function isInvalidValue(data, type) {
    let retVal = false;

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
    const unitObj = FIT.options[unitsList][speedUnit];
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
        default: return data;
    }
}

export function readRecord(blob, messageTypes, developerFields, startIndex, options, startDate) {
    const recordHeader = blob[startIndex];
    let localMessageType = recordHeader & 15;

    if((recordHeader & CompressedHeaderMask) === CompressedHeaderMask){
        //compressed timestamp

        var timeoffset = recordHeader & CompressedTimeMask;
        timestamp += ((timeoffset - lastTimeOffset) & CompressedTimeMask);
        lastTimeOffset = timeoffset;

        localMessageType = ((recordHeader & CompressedLocalMesgNumMask) >> 5);
    } else if ((recordHeader & 64) === 64) {
        // is definition message
        // startIndex + 1 is reserved

        const hasDeveloperData = (recordHeader & 32) === 32;
        const lEnd = blob[startIndex + 2] === 0;
        const numberOfFields = blob[startIndex + 5];
        const numberOfDeveloperDataFields = hasDeveloperData ? blob[startIndex + 5 + numberOfFields * 3 + 1] : 0;

        const mTypeDef = {
            littleEndian: lEnd,
            globalMessageNumber: addEndian(lEnd, [blob[startIndex + 3], blob[startIndex + 4]]),
            numberOfFields: numberOfFields + numberOfDeveloperDataFields,
            fieldDefs: [],
        };

        const message = getFitMessage(mTypeDef.globalMessageNumber);

        for (let i = 0; i < numberOfFields; i++) {
            const fDefIndex = startIndex + 6 + (i * 3);
            const baseType = blob[fDefIndex + 2];
            const { field, type } = message.getAttributes(blob[fDefIndex]);
            const fDef = {
                type,
                fDefNo: blob[fDefIndex],
                size: blob[fDefIndex + 1],
                endianAbility: (baseType & 128) === 128,
                littleEndian: lEnd,
                baseTypeNo: (baseType & 15),
                name: field,
                dataType: getFitMessageBaseType(baseType & 15),
            };

            mTypeDef.fieldDefs.push(fDef);
        }
        
        for (let i = 0; i < numberOfDeveloperDataFields; i++) {
            const fDefIndex = startIndex + 6 + (numberOfFields * 3) + 1 + (i * 3);

            const fieldNum = blob[fDefIndex];
            const size = blob[fDefIndex + 1];
            const devDataIndex = blob[fDefIndex + 2];

            const devDef = developerFields[devDataIndex][fieldNum];

            const baseType = devDef.fit_base_type_id;

            const fDef = {
                type: FIT.types.fit_base_type[baseType],
                fDefNo: fieldNum,
                size: size,
                endianAbility: (baseType & 128) === 128,
                littleEndian: lEnd,
                baseTypeNo: (baseType & 15),
                name: devDef.field_name,
                dataType: getFitMessageBaseType(baseType & 15),
                isDeveloperField: true,
            };

            mTypeDef.fieldDefs.push(fDef);
        }
       
        messageTypes[localMessageType] = mTypeDef;

        const nextIndex = startIndex + 6 + (mTypeDef.numberOfFields * 3);
        const nextIndexWithDeveloperData = nextIndex + 1;

        return {
            messageType: 'definition',
            nextIndex: hasDeveloperData ? nextIndexWithDeveloperData : nextIndex
        };
    }

    const messageType = messageTypes[localMessageType] || messageTypes[0];

    // TODO: handle compressed header ((recordHeader & 128) == 128)

    // uncompressed header
    let messageSize = 0;
    let readDataFromIndex = startIndex + 1;
    const fields = {};
    const message = getFitMessage(messageType.globalMessageNumber);

    for (let i = 0; i < messageType.fieldDefs.length; i++) {
        const fDef = messageType.fieldDefs[i];
        const data = readData(blob, fDef, readDataFromIndex);

        if (!isInvalidValue(data, fDef.type)) {
            if (fDef.isDeveloperField) {
                // Skip format of data if developer field
                fields[fDef.name] = data;
            } else {
                const mDef = message.getAttributes(fDef.fDefNo);

                if (mDef.field !== 'unknown' && mDef.field !== '' && mDef.field !== undefined) {
                    fields[mDef.field] = applyOptions(formatByType(data, mDef.type, mDef.scale, mDef.offset), mDef.field, options);
                
                    if(mDef.components){                          
                        let tdata = data;      
                        let offset = 0;
                        for(let j = 0; j < mDef.components.length; j++){
                            const cDef = mDef.components[j];
                            let value = 0;
                            let bitsInData = 0;
                            let bitsInValue = 0;
                            let mask = 0;
                            while (bitsInValue < cDef.bits)
                            {
                                tdata >>= offset;
                                bitsInData = fDef.size * 8 - offset;
                                offset -= fDef.size * 8;
                                if(bitsInData > 0){
                                    // We have reached desired data, pull off bits until we
                                    // get enough
                                    offset = 0;
                                    // If there are more bits available in data than we need
                                    // just capture those we need
                                    if (bitsInData > (cDef.bits - bitsInValue))
                                    {
                                        bitsInData = cDef.bits - bitsInValue;
                                    }
                                    mask = (1 << bitsInData) - 1;
                                    value |= ((tdata & mask) << bitsInValue);
                                    bitsInValue += bitsInData;
                                }
                            }
                            
                            fields[cDef.field] = formatByType(value, cDef.type, cDef.scale, cDef.offset);
                            offset += cDef.bits;
                        }
                    }
                }
            }

            if (message.name === 'record' && options.elapsedRecordField) {
                fields.elapsed_time = (fields.timestamp - startDate) / 1000;
            }            
        }

        readDataFromIndex += fDef.size;
        messageSize += fDef.size;
    }

    if (message.name === 'field_description') {
        developerFields[fields.developer_data_index] = developerFields[fields.developer_data_index] || [];
        developerFields[fields.developer_data_index][fields.field_definition_number] = fields;
    }

    if (message.name === 'monitoring') {
        //we need to keep the raw timestamp value so we can calculate subsequent timestamp16 fields
        if(fields.timestamp){
            monitoring_timestamp = fields.timestamp;
            fields.timestamp = new Date(fields.timestamp * 1000 + GarminTimeOffset);
        }
        if(fields.timestamp16 && !fields.timestamp){
            monitoring_timestamp += ( fields.timestamp16 - ( monitoring_timestamp & 0xFFFF ) ) & 0xFFFF;
            //fields.timestamp = monitoring_timestamp;
            fields.timestamp = new Date(monitoring_timestamp * 1000 + GarminTimeOffset);
        }
    }

    const result = {
        messageType: message.name,
        nextIndex: startIndex + messageSize + 1,
        message: fields,
    };

    return result;
}

export function getArrayBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) {
        return buffer;
    }
    const ab = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buffer.length; ++i) {
        view[i] = buffer[i];
    }
    return ab;
}

export function calculateCRC(blob, start, end) {
    const crcTable = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];

    let crc = 0;
    for (let i = start; i < end; i++) {
        const byte = blob[i];
        let tmp = crcTable[crc & 0xF];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ crcTable[byte & 0xF];
        tmp = crcTable[crc & 0xF];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ crcTable[(byte >> 4) & 0xF];
    }

    return crc;
}
