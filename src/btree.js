const { Utils } = require('acebase-core');
const { numberToBytes, bytesToNumber, encodeString, decodeString } = Utils;
const ThreadSafe = require('./thread-safe');
const { DetailedError } = require('./detailed-error');
const fs = require('fs');
require('./promise-try-shim');

const KEY_TYPE = {
    UNDEFINED: 0,
    STRING: 1,
    NUMBER: 2,
    BOOLEAN: 3,
    DATE: 4
};

const FLAGS = {
    UNIQUE_KEYS: 1,
    HAS_METADATA: 2,
    HAS_FREE_SPACE: 4,
    HAS_FILL_FACTOR: 8,
    HAS_SMALL_LEAFS: 16,
    HAS_LARGE_PTRS: 32,
    ENTRY_HAS_EXT_DATA: 128, // leaf entry value's val_length
    IS_LEAF: 1,
    LEAF_HAS_EXT_DATA: 2
};

const WRITE_SMALL_LEAFS = true;
const MAX_SMALL_LEAF_VALUE_LENGTH = 127 - 4; // -4 because value_list_length is now included in data length
const MAX_LEAF_ENTRY_VALUES = Math.pow(2, 32) - 1;

const _appendToArray = (targetArray, arr2) => {
    let start = 0, n = 255; 
    while (start < arr2.length) {
        targetArray.push(...arr2.slice(start, start + n));
        start += n;
    }
};

function _getComparibleValue(val) {
    if (typeof val === 'undefined' || val === null) { val = null; }
    else if (val instanceof Date) { val = val.getTime(); }
    return val;
}

// Typeless comparison methods
function _isEqual(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (typeof val1 !== typeof val2) { return false; }
    return val1 === val2;
}
function _isNotEqual(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (typeof val1 !== typeof val2) { return true; }
    return val1 != val2;
}
function _isLess(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (val2 === null) { return false; }
    if (val1 === null) { return val2 !== null; }
    if (typeof val1 !== typeof val2) { return typeof val1 < typeof val2; } // boolean, number (+Dates), string
    return val1 < val2;
}
function _isLessOrEqual(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (val1 === null) { return true; }
    else if (val2 === null) { return false; }
    if (typeof val1 !== typeof val2) { return typeof val1 < typeof val2; } // boolean, number (+Dates), string
    return val1 <= val2;
}
function _isMore(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (val1 === null) { return false; }
    else if (val2 === null) { return true; }
    if (typeof val1 !== typeof val2) { return typeof val1 > typeof val2; } // boolean, number (+Dates), string
    return val1 > val2;
}
function _isMoreOrEqual(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (val1 === null) { return val2 === null; }
    else if (val2 === null) { return true; }
    if (typeof val1 !== typeof val2) { return typeof val1 > typeof val2; } // boolean, number (+Dates), string
    return val1 >= val2;
}
function _sortCompare(val1, val2) {
    val1 = _getComparibleValue(val1);
    val2 = _getComparibleValue(val2);
    if (val1 === null && val2 !== null) { return -1; }
    if (val1 !== null && val2 === null) { return 1; }
    if (typeof val1 !== typeof val2) { 
        // boolean, number (+Dates), string
        if (typeof val1 < typeof val2) { return -1; }
        if (typeof val1 > typeof val2) { return 1; }
    } 
    if (val1 < val2) { return -1; }
    if (val1 > val2) { return 1; }
    return 0;
}

const _numberRegex = /^[1-9][0-9]*$/;
/**
 * @param {string} str 
 * @returns {boolean}
 */
function _isIntString(str) {
    return typeof str === 'string' && _numberRegex.test(str);
}

function _normalizeKey(key) {
    key = _getComparibleValue(key);
    return key === null ? null : key.toString();
}

/**
 * 
 * @param {number[]} val1 
 * @param {number[]} val2 
 */
function _compareBinary(val1, val2) {
    return val1.length === val2.length && val1.every((byte, index) => val2[index] === byte);
}

/**
 * 
 * @param {number[]} val1 
 * @param {number[]} val2 
 */
function _compareBinaryDetails(val1, val2) {
    let smaller = val1.length < val1.length ? val1 : val2;
    return smaller.reduce((arr, current, index) => {
        if (val1[index] !== val2[index]) { arr.push({ index, val1: val1[index], val2: val2[index] }); }
        return arr;
    }, []);
}

const _maxSignedNumber = Math.pow(2, 31) - 1;
function _writeSignedNumber (bytes, index, offset, debugName) {
    const negative = offset < 0;
    if (negative) { offset = -offset; }
    if (offset > _maxSignedNumber) {
        throw new Error(`reference offset to big to store in 31 bits`);
    }
    bytes[index] = ((offset >> 24) & 0x7f) | (negative ? 0x80 : 0);
    // if (debugName) {
    //     data[index] = [debugName, data[index]];
    // }
    bytes[index+1] = (offset >> 16) & 0xff;
    bytes[index+2] = (offset >> 8) & 0xff;
    bytes[index+3] = offset & 0xff;
    return bytes;
};
function _readSignedNumber (bytes, index) {
    let nr = ((bytes[index] & 0x7f) << 24) | (bytes[index+1] << 16) | (bytes[index+2] << 8)  | bytes[index+3];
    let isNegative = (bytes[index] & 0x80) > 0;
    if (isNegative) { nr = -nr; }
    return nr;
};
// const _maxSignedOffset = (2n ** 47n) - 1n; //Math.pow(2, 47) - 1;
// function _writeSignedOffset (bytes, index, offset, large = false) {
//     if (!large) { 
//         throw new Error('DEV: write large offsets only! (remove error later when successfully implemented)');
//         return _writeSignedNumber(bytes, index, offset); 
//     }
//     offset = BigInt(offset); // convert into BigInt
//     const negative = offset < 0n;
//     if (negative) { offset = -offset; }
//     if (offset > _maxSignedOffset) {
//         throw new Error(`reference offset to big to store in 47 bits`);
//     }
//     bytes[index] = Number(((offset >> 40n) & 0x7fn) | (negative ? 0x80n : 0n));
//     bytes[index+1] = Number((offset >> 32n) & 0xffn);
//     bytes[index+2] = Number((offset >> 24n) & 0xffn);
//     bytes[index+3] = Number((offset >> 16n) & 0xffn);
//     bytes[index+4] = Number((offset >> 8n) & 0xffn);
//     bytes[index+5] = Number(offset & 0xffn);
//     return bytes;
// };'
// function _readSignedOffset (bytes, index, large = false) {
//     if (!large) { 
//         // throw new Error('DEV: read large offsets only! (remove error later when successfully implemented)');
//         return _readSignedNumber(bytes, index); 
//     }
//     let offset = ((BigInt(bytes[index]) & 0x7fn) << 40n) | (BigInt(bytes[index+1]) << 32n) | (BigInt(bytes[index+2]) << 24n) | (BigInt(bytes[index+3]) << 16n) | (BigInt(bytes[index+4]) << 8n)  | BigInt(bytes[index+5]);
//     let isNegative = (BigInt(bytes[index]) & 0x80n) > 0n;
//     if (isNegative) { offset = -offset; }
//     return Number(offset);
// };

const _maxSignedOffset = Math.pow(2, 47) - 1;
// input: 2315765760
// expected output: [0, 0, 138, 7, 200, 0]
function _writeSignedOffset(bytes, index, offset, large = false) {
    if (!large) { 
        throw new Error('DEV: write large offsets only! (remove error later when successfully implemented)');
        return _writeSignedNumber(bytes, index, offset); 
    }
    const negative = offset < 0;
    if (negative) { offset = -offset; }
    if (offset > _maxSignedOffset) {
        throw new Error(`reference offset to big to store in 47 bits`);
    }
    // Bitwise operations in javascript are 32 bits, so they cannot be used on larger numbers
    // Split the large number into 6 8-bit numbers by division instead
    let n = offset;
    for (let i = 0; i < 6; i++) {
        const b = n & 0xff;
        bytes[index + 5 - i] = b;
        n = n <= b ? 0 : (n - b) / 256;
    }
    if (negative) {
        bytes[index] |= 0x80;
    }
    return bytes;
};
function _readSignedOffset (bytes, index, large = false) {
    if (!large) { 
        // throw new Error('DEV: read large offsets only! (remove error later when successfully implemented)');
        return _readSignedNumber(bytes, index); 
    }
    let offset = 0;
    const isNegative = (bytes[index] & 0x80) > 0;
    for (let i = 0; i < 6; i++) {
        let b = bytes[index + i];
        if (i === 0 && isNegative) { b ^= 0x80; }
        offset += b * Math.pow(2, (5 - i) * 8);
    }
    if (isNegative) { offset = -offset; }
    return offset;
};
function _writeByteLength(bytes, index, length) {
    bytes[index] = (length >> 24) & 0xff;
    bytes[index+1] = (length >> 16) & 0xff;
    bytes[index+2] = (length >> 8) & 0xff;
    bytes[index+3] = length & 0xff;   
    return bytes; 
}
function _readByteLength(bytes, index) {
    let length = (bytes[index] << 24) 
        | (bytes[index+1] << 16)
        | (bytes[index+2] << 8)
        | bytes[index+3];
    return length;
}

class BPlusTreeNodeEntry {
    /**
     * 
     * @param {BPlusTreeNode} node 
     * @param {string|number|boolean|Date} key 
     */
    constructor(node, key) {
        this.node = node;
        this.key = key;
        /**
         * @type {BPlusTreeNode|BPlusTreeLeaf}
         */
        this.ltChild = null;
    }
}

class BPlusTreeNode {
    /**
     * 
     * @param {BPlusTree} tree 
     * @param {BPlusTreeNode} parent 
     */
    constructor(tree, parent) {
        this.tree = tree;
        this.parent = parent;
        /**
         * @type {BPlusTreeNodeEntry[]}
         */
        this.entries = [];

        /**
         * @type {BPlusTreeNode|BPlusTreeLeaf}
         */
        this.gtChild = null;
    }

    toString() {
        let str = "Node: [" + this.entries.map(entry => entry.key).join(" | ") + "]";
        str += " --> ";
        str += this.entries.map(entry => entry.ltChild.toString()).join(", ");
        str += ", " + this.gtChild.toString();
        return str;
    }    

    /**
     * 
     * @param {string|number|boolean|Date|undefined} newKey 
     * @param {BPlusTreeLeaf} fromLeaf 
     * @param {BPlusTreeLeaf} newLeaf 
     */
    insertKey(newKey, fromLeaf, newLeaf) {
        // New key is being inserted from splitting leaf node
        if (this.entries.findIndex(entry => _isEqual(entry.key, newKey)) >= 0) {
            throw new DetailedError('node-key-exists', `Key ${newKey} is already present in node`);
        }

        const newNodeEntry = new BPlusTreeNodeEntry(this, newKey);
        if (this.gtChild === fromLeaf) {
            newNodeEntry.ltChild = fromLeaf;
            this.gtChild = newLeaf;
            this.entries.push(newNodeEntry);
        }
        else {
            const oldNodeEntry = this.entries.find(entry => entry.ltChild === fromLeaf);
            const insertIndex = this.entries.indexOf(oldNodeEntry);
            newNodeEntry.ltChild = fromLeaf;
            oldNodeEntry.ltChild = newLeaf;
            this.entries.splice(insertIndex, 0, newNodeEntry);
        }

        this._checkSize();
    }

    _checkSize() {
        // Check if there are too many entries
        if (this.entries.length > this.tree.maxEntriesPerNode) {
            // Split this node
            // A = [ 10, 20, 30, 40 ] becomes A = [ 10, 20 ], B = [ 40 ], C = 30 moves to parent
            // B's gtChild (-) becomes A's gtChild (>=40)
            // A's gtChild (>=40) becomes C's ltChild (<30)
            // C's ltChild (<30) becomes A
            // C's entry_index+1.ltChild (when inserted, or C's node.gtChild when appended) becomes B
            const splitIndex = Math.ceil(this.tree.maxEntriesPerNode / 2);
            const moveEntries = this.entries.splice(splitIndex);
            const moveUpEntry = moveEntries.shift();
            const ltChild = moveUpEntry.ltChild;
            moveUpEntry.ltChild = this;
            const gtChild = this.gtChild;
            this.gtChild = ltChild;

            if (this.parent === null) {
                // Create new root node
                const newRoot = new BPlusTreeNode(this.tree, null);
                newRoot.entries = [moveUpEntry];
                const newSibling = new BPlusTreeNode(this.tree, newRoot);
                newSibling.entries = moveEntries;
                moveEntries.forEach(entry => entry.ltChild.parent = newSibling);
                newRoot.gtChild = newSibling;
                newSibling.gtChild = gtChild;
                gtChild.parent = newSibling;
                this.parent = newRoot;
                this.tree.root = newRoot;
                this.tree.depth++;
            }
            else {
                const newSibling = new BPlusTreeNode(this.tree, this.parent);
                newSibling.entries = moveEntries;
                moveEntries.forEach(entry => entry.ltChild.parent = newSibling);
                newSibling.gtChild = gtChild;
                gtChild.parent = newSibling;

                // Find where to insert moveUp
                const insertIndex = this.parent.entries.findIndex(entry => _isMore(entry.key, moveUpEntry.key));
                if (insertIndex < 0) {
                    // Add to the end
                    this.parent.entries.push(moveUpEntry);
                    this.parent.gtChild = newSibling;
                }
                else {
                    // Insert somewhere in between
                    let insertBefore = this.parent.entries[insertIndex];
                    insertBefore.ltChild = newSibling;
                    this.parent.entries.splice(insertIndex, 0, moveUpEntry);
                }

                this.parent._checkSize(); // Let it check its size
            }
        }
    }

    /**
     * BPlusTreeNode.toBinary
     * @param {boolean} keepFreeSpace 
     * @param {BinaryWriter} writer
     */
    toBinary(keepFreeSpace, writer) {
        // EBNF layout:
        // data                 = byte_length, index_type, max_node_entries, [fill_factor], [free_byte_length], [metadata_keys], root_node
        // byte_length          = 4 byte number (byte count) 
        // data_byte_length     = byte_length: NEVER INCLUDES ITS OWN BYTE SIZE OR OTHER HEADER BYTE SIZES
        // index_type           = 1 byte = [0, 0, has_large_ptrs, has_small_leafs, has_fill_factor, has_free_space, has_metadata, is_unique]
        // max_node_entries     = 1 byte number
        // fill_factor          = 1 byte number (max 100)
        // metadata_keys        = has_metadata?
        //                          1: metadata_length, metadata_key_count, metadata_key, [metadata_key, [metadata_key...]]
        //                          0: not present
        // metadata_length      = byte_length
        // metadata_key_count   = 1 byte number
        // metadata_key         = metadata_key_length, metadata_key_name
        // metadata_key_length  = 1 byte number
        // metadata_key_name    = [metadata_key_length] bytes (TextEncoded char codes)
        // root_node            = node | leaf
        // node*                = byte_length***, is_leaf, free_byte_length, entries_length, entries, gt_child_ptr, free_bytes, children
        // is_leaf              = 1 byte leaf_flags
        //                          >=1: yes, leaf
        //                          0: no, it's a node
        // free_byte_length     = byte_length (how many bytes are free for later additions)
        // entries_length       = 1 byte number
        // entries              = entry, [entry, [entry...]]
        // entry                = key, lt_child_ptr
        // key                  = key_type, key_length, key_data
        // key_type             = 1 byte number
        //                          0: UNDEFINED (equiv to sql null values)
        //                          1: STRING
        //                          2: NUMBER
        //                          3: BOOLEAN
        //                          4: DATE
        // key_length           = 1 byte number
        // key_data             = [key_length] bytes (ASCII chars when key is string)
        // lt_child_ptr         = offset_ptr (byte offset to node | leaf)
        // gt_child_ptr         = offset_ptr (byte offset to node | leaf)
        // children             = node, [node, [node...]] | leaf, [leaf, [leaf...]]
        // leaf**               = byte_length***, leaf_flags, free_byte_length, prev_leaf_ptr, next_leaf_ptr, [ext_byte_length, ext_free_byte_length], entries_length, leaf_entries, free_bytes, [ext_data]
        // leaf_flags           = 1 byte = [0, 0, 0, 0, 0, 0, has_ext_data, is_leaf]
        // prev_leaf_ptr        = offset_ptr (byte offset to leaf)
        // next_leaf_ptr        = offset_ptr (byte offset to leaf)
        // leaf_entries         = leaf_entry, [leaf_entry, [leaf_entry...]]
        // leaf_entry           = key, val
        // offset_ptr           = has_large_ptrs?
        //                          0: signed_number
        //                          1: large_signed_number
        // small_offset_ptr     = signed_number
        // signed_number        = 4 bytes, 32 bits = [negative_flag, ...bits]
        // large_signed_number  = 6 bytes, 48 bits = [negative_flag, ...bits]
        // val                  = val_length, val_data
        // val_length           = has_small_leafs?
        //                          1: 1 byte number: [1 bit has_ext_data, 7 bit byte count]
        //                          0: 4 byte number (byte count)
        // val_data             = is_unique?
        //                          1: value
        //                          0: has_ext_data?
        //                              1: value_list_length, ext_data_ptr
        //                              0: value_list
        // ext_data_ptr         = byte_length (byte offset from leaf end to ext_data_block)
        // value_list           = value_list_length, value, [value, [value...]]
        // value_list_length    = 4 byte number
        // value                = value_length, value_data, metadata
        // value_length         = 1 byte number
        // value_data           = [value_length] bytes data
        // metadata             = metadata_value{metadata_key_count}
        // metadata_value       = metadata_value_type, metadata_value_length, metadata_value_data
        // metadata_value_type  = key_type
        // metadata_value_length= key_length
        // metadata_value_data  = key_data
        // ext_data             = ext_data_block, [ext_data_block, [ext_data_block]]
        // ext_data_block       = ext_block_length, ext_block_free_length, data
        // ext_block_length     = data_byte_length
        // ext_block_free_length= free_byte_length
        //
        // * Written by BPlusTreeNode.toBinary
        // ** Written by BPlusTreeLeaf.toBinary
        // *** including free bytes (BUT excluding size of ext_data blocks for leafs)

        let bytes = [];
        const startIndex = writer.length; //bytes.length;

        // byte_length:
        bytes.push(0, 0, 0, 0);

        // is_leaf:
        bytes.push(0); // (no)

        // free_byte_length:
        bytes.push(0, 0, 0, 0); // Now used!

        // entries_length:
        bytes.push(this.entries.length);

        let pointers = [],      // pointers refer to an offset in the binary data where nodes/leafs can be found
            references = [];    // references point to an index in the binary data where pointers are to be stored
        
        this.entries.forEach(entry => {
            let keyBytes = BPlusTree.getBinaryKeyData(entry.key);
            bytes.push(...keyBytes);

            // lt_child_ptr:
            let index = startIndex + bytes.length;
            bytes.push(0, 0, 0, 0, 0, 0);
            references.push({ name: `<${entry.key}`, index, node: entry.ltChild });
        });

        // gt_child_ptr:
        let index = startIndex + bytes.length;
        bytes.push(0, 0, 0, 0, 0, 0);
        references.push({ name: `>${this.entries[this.entries.length - 1].key}`, index, node: this.gtChild });

        let freeBytes = 0;
        if (keepFreeSpace) {
            // Add free space
            let avgEntrySize = Math.ceil(bytes.length / this.entries.length);
            let freeEntries = this.tree.maxEntriesPerNode - this.entries.length;
            freeBytes = freeEntries * avgEntrySize;

            for(let i = 0; i < freeBytes; i++) { bytes.push(0); }

            // update free_byte_length:
            _writeByteLength(bytes, 5, freeBytes);
        }

        // update byte_length:
        _writeByteLength(bytes, 0, bytes.length);

        // Flush bytes, continue async
        return writer.append(bytes)
        .then(() => {

            // Now add children
            const addChild = (childNode, name) => {
                let index = writer.length;
                const refIndex = references.findIndex(ref => ref.node === childNode);
                const ref = references.splice(refIndex, 1)[0];
                const offset = index - (ref.index + 5); // index - (ref.index + 3);
                
                // Update child_ptr
                const child_ptr = _writeSignedOffset([], 0, offset, true);

                return writer.write(child_ptr, ref.index)  // Update pointer
                .then(() => {
                    return childNode.toBinary(keepFreeSpace, writer) // Add child                    
                })
                .then(child => {
                    if (childNode instanceof BPlusTreeLeaf) {
                        // Remember location we stored this leaf, we need it later
                        pointers.push({ 
                            name, 
                            leaf: childNode, 
                            index
                        });
                    }
                    // Add node pointers added by the child
                    child.pointers && child.pointers.forEach(pointer => {
                        // pointer.index += index; // DISABLED: indexes must already be ok now we're using 1 bytes array
                        pointers.push(pointer);
                    });
                    // Add unresolved references added by the child
                    child.references.forEach(ref => {
                        // ref.index += index; // DISABLED: indexes must already be ok now we're using 1 bytes array
                        references.push(ref);
                    });
                });
            };

            let childIndex = 0;
            const nextChild = () => {
                let entry = this.entries[childIndex];
                let isLast = !entry;
                let child = entry ? entry.ltChild : this.gtChild;
                let name = entry ? `<${entry.key}` : `>=${this.entries[this.entries.length-1].key}`;
                return addChild(child, name)
                .then(() => {
                    if (!isLast) {
                        childIndex++;
                        return nextChild();
                    }
                })
                .then(() => {
                    // Check if we can resolve any leaf references
                    return BPlusTreeNode.resolveBinaryReferences(writer, references, pointers);
                })
                .then(() => {
                    return { references, pointers };
                });
            }
            return nextChild();
        });
    }

    static resolveBinaryReferences(writer, references, pointers) {
        let maxOffset = Math.pow(2, 31) - 1;
        // Make async
        let pointerIndex = 0;
        function nextPointer() {
            const pointer = pointers[pointerIndex];
            if (!pointer) { return Promise.resolve(); }
            const nextReference = () => {
                const i = references.findIndex(ref => ref.target === pointer.leaf);
                if (i < 0) { return Promise.resolve(); }
                let ref = references.splice(i, 1)[0]; // remove it from the references
                let offset = pointer.index - ref.index;
                const bytes = _writeSignedOffset([], 0, offset, true);
                return writer.write(bytes, ref.index)
                .then(() => {
                    return nextReference();
                });
            }
            return nextReference()
            .then(() => {
                pointerIndex++;
                return nextPointer();
            });
        }
        return nextPointer();
    }

}

class BPlusTreeLeafEntryValue {
    /**
     * @param {number[]|Uint8Array} recordPointer used to be called "value", renamed to prevent confusion
     * @param {object} [metadata] 
     */
    constructor(recordPointer, metadata) {
        this.recordPointer = recordPointer;
        this.metadata = metadata;
    }

    /** @deprecated use .recordPointer instead */
    get value() {
        return this.recordPointer;
    }
}

class BPlusTreeLeafEntry {
    /**
     * 
     * @param {BPlusTreeLeaf} leaf 
     * @param {string|number|boolean|Date|undefined} key 
     * @param {BPlusTreeLeafEntryValue} [value] 
     */
    constructor(leaf, key, value) {
        if (typeof value !== 'undefined' && !(value instanceof BPlusTreeLeafEntryValue)) {
            throw new Error(`value must be an instance of BPlusTreeLeafEntryValue`);
        }
        this.leaf = leaf;
        this.key = key;
        this.values = typeof value === 'undefined' ? [] : [value];
    }
}

class BPlusTreeLeaf {
    /**
     * 
     * @param {BPlusTree|BPlusTreeNode} parent 
     */
    constructor(parent) {
        /**
         * @type {BPlusTree|BPlusTreeNode}
         */
        this.parent = parent;
        /**
         * @type {BPlusTreeLeafEntry[]}
         */
        this.entries = [];
        /**
         * @type {BPlusTreeLeaf}
         */
        this.prevLeaf = null;
        /**
         * @type {BPlusTreeLeaf}
         */
        this.nextLeaf = null;
    }

    /**
     * The BPlusTree this leaf is in
     * @type {BPlusTree}
     */
    get tree() {
        return this.parent instanceof BPlusTree ? this.parent : this.parent.tree;
    }

    /**
     * Adds an entry to this leaf
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer data to store with the key, max size is 255
     * @param {object} [metadata] data to include, must contain all keys used in BPlusTree constructor
     * @returns {BPlusTreeLeafEntry} returns the added leaf entry
     */
    add(key, recordPointer, metadata) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        if (typeof recordPointer === "string") {
            // For now, allow this. Convert to byte array
            console.warn(`WARNING: converting recordPointer "${recordPointer}" to byte array. This is deprecated, will fail in the future`);
            let bytes = [];
            for(let i = 0; i < recordPointer.length; i++) {
                bytes.push(recordPointer.charCodeAt(i));
            }
            recordPointer = bytes;
        }
        const err = _checkNewEntryArgs(key, recordPointer, this.tree.metadataKeys, metadata);
        if (err) {
            throw err;
        }

        const entryValue = new BPlusTreeLeafEntryValue(recordPointer, metadata);

        // First. check if we already have an entry with this key
        const entryIndex = this.entries.findIndex(entry => _isEqual(entry.key, key));
        if (entryIndex >= 0) {
            if (this.tree.uniqueKeys) {
                throw new DetailedError('duplicate-node-key', `Cannot insert duplicate key ${key}`);
            }
            const entry = this.entries[entryIndex];
            entry.values.push(entryValue);
            return entry;
        }

        // New key, create entry
        const entry = new BPlusTreeLeafEntry(this, key, entryValue);
        if (this.entries.length === 0) {
            this.entries.push(entry);
        }
        else {
            // Find where to insert sorted
            let insertIndex = this.entries.findIndex(otherEntry => _isMore(otherEntry.key, entry.key));
            if (insertIndex < 0) { 
                this.entries.push(entry);
            }
            else {
                this.entries.splice(insertIndex, 0, entry);
            }

            // FInd out if there are too many entries
            if (this.entries.length > this.tree.maxEntriesPerNode) {
                // Split the leaf
                const splitIndex = Math.ceil(this.tree.maxEntriesPerNode / 2);
                const moveEntries = this.entries.splice(splitIndex);
                const copyUpKey = moveEntries[0].key;
                if (this.parent instanceof BPlusTree) {
                    // We have to create the first parent node
                    const tree = this.parent;
                    this.parent = new BPlusTreeNode(tree, null);
                    tree.root = this.parent;
                    tree.depth = 2;
                    const newLeaf = new BPlusTreeLeaf(this.parent);
                    newLeaf.entries = moveEntries;
                    const newEntry = new BPlusTreeNodeEntry(this.parent, copyUpKey);
                    newEntry.ltChild = this;
                    this.parent.gtChild = newLeaf;
                    this.parent.entries = [newEntry];

                    // Update linked list pointers
                    newLeaf.prevLeaf = this;
                    if (this.nextLeaf) {
                        newLeaf.nextLeaf = this.nextLeaf;
                        newLeaf.nextLeaf.prevLeaf = newLeaf;
                    }
                    this.nextLeaf = newLeaf;
                }
                else {
                    const newLeaf = new BPlusTreeLeaf(this.parent);
                    newLeaf.entries = moveEntries;
                    this.parent.insertKey(copyUpKey, this, newLeaf);

                    // Update linked list pointers
                    newLeaf.prevLeaf = this;
                    if (this.nextLeaf) {
                        newLeaf.nextLeaf = this.nextLeaf;
                        newLeaf.nextLeaf.prevLeaf = newLeaf;
                    }
                    this.nextLeaf = newLeaf;  
                }
            }
        }
        return entry;
    }

    toString() {
        let str = "Leaf: [" + this.entries.map(entry => entry.key).join(" | ") + "]";
        return str;
    }

    /**
     * BPlusTreeLeaf.toBinary
     * @param {boolean} keepFreeSpace 
     * @param {BinaryWriter} writer
     */
    toBinary(keepFreeSpace = false, writer) {
        // See BPlusTreeNode.toBinary() for data layout

        console.assert(this.entries.every((entry, index, arr) => index === 0 || _isMore(entry.key, arr[index-1].key)), 'Leaf entries are not sorted ok');

        const bytes = [];
        const startIndex = writer.length;

        // byte_length:
        bytes.push(0, 0, 0, 0);

        // leaf_flags:
        const leafFlagsIndex = bytes.length;
        bytes.push(FLAGS.IS_LEAF);

        // free_byte_length:
        bytes.push(0, 0, 0, 0);

        const references = [];

        // prev_leaf_ptr:
        this.prevLeaf && references.push({ name: `<${this.entries[0].key}`, target: this.prevLeaf, index: startIndex + bytes.length });
        bytes.push(0, 0, 0, 0, 0, 0);

        // next_leaf_ptr:
        this.nextLeaf && references.push({ name: `>${this.entries[this.entries.length-1].key}`, target: this.nextLeaf, index: startIndex + bytes.length });
        bytes.push(0, 0, 0, 0, 0, 0);

        // ext_byte_length, ext_free_byte_length: (will be removed when no ext_data is written)
        const extDataHeaderIndex = bytes.length;
        bytes.push(
            0, 0, 0, 0, // ext_byte_length
            0, 0, 0, 0  // ext_free_byte_length
        );        

        // entries_length:
        bytes.push(this.entries.length);

        const entriesStartIndex = bytes.length;
        const moreDataBlocks = [];
        this.entries.forEach(entry => {

            console.assert(entry.values.length <= MAX_LEAF_ENTRY_VALUES, 'too many leaf entry values to store in binary');

            let keyBytes = BPlusTree.getBinaryKeyData(entry.key);
            bytes.push(...keyBytes);

            // val_length:
            const valLengthIndex = bytes.length;
            if (WRITE_SMALL_LEAFS) {
                bytes.push(0);
            }
            else {
                bytes.push(0, 0, 0, 0);
            }
            let valueBytes = [];

            /**
             * 
             * @param {BPlusTreeLeafEntryValue} entryValue 
             */
            const writeValue = (entryValue) => {
                const { recordPointer, metadata } = entryValue;

                // const startIndex = bytes.length;
                // const target = valueBytes;

                // value_length:
                valueBytes.push(recordPointer.length);

                // value_data:
                valueBytes.push(...recordPointer);

                // metadata:
                this.tree.metadataKeys.forEach(key => {
                    const metadataValue = metadata[key];
                    const mdBytes = BPlusTree.getBinaryKeyData(metadataValue); // metadata_value has same structure as key, so getBinaryKeyData comes in handy here
                    valueBytes.push(...mdBytes);
                });
            };

            if (this.tree.uniqueKeys) {
                // value:
                writeValue(entry.values[0]);
            }
            else {
                entry.values.forEach(entryValue => {
                    // value:
                    writeValue(entryValue);
                });
            }
            
            if (WRITE_SMALL_LEAFS && valueBytes.length > MAX_SMALL_LEAF_VALUE_LENGTH) {
                // Values too big for small leafs
                // Store value bytes in ext_data block

                if (!this.tree.uniqueKeys) {
                    // value_list_length:
                    _writeByteLength(bytes, bytes.length, entry.values.length);
                }

                // ext_data_ptr:
                const extPointerIndex = bytes.length;
                bytes.push(0, 0, 0, 0); 

                // update val_length:
                bytes[valLengthIndex] = FLAGS.ENTRY_HAS_EXT_DATA;

                // add
                moreDataBlocks.push({ 
                    pointerIndex: extPointerIndex, 
                    bytes: valueBytes
                });
            }
            else {
                // update val_length:
                const valLength = valueBytes.length + (this.tree.uniqueKeys ? 0 : 4); // +4 to include value_list_length bytes //bytes.length - valLengthIndex - 4;
                if (WRITE_SMALL_LEAFS) {
                    bytes[valLengthIndex] = valLength;
                }
                else {
                    _writeByteLength(bytes, valLengthIndex, valLength);
                }

                if (!this.tree.uniqueKeys) {
                    // value_list_length:
                    _writeByteLength(bytes, bytes.length, entry.values.length);
                }

                // add value bytes:
                _appendToArray(bytes, valueBytes);
            }

        });

        // Add free space
        const entriesDataSize = bytes.length - entriesStartIndex;
        const avgBytesPerEntry = Math.ceil(entriesDataSize / this.entries.length);
        const availableEntries = this.tree.maxEntriesPerNode - this.entries.length;
        const freeBytesLength = 
            keepFreeSpace && this.entries.length > 0
            ? Math.ceil(availableEntries * avgBytesPerEntry * 1.1) // + 10%
            : 0;
        for (let i = 0; i < freeBytesLength; i++) { bytes.push(0); }

        const hasExtData = moreDataBlocks.length > 0;
        if (hasExtData) {
            // update leaf_flags:
            bytes[leafFlagsIndex] |= FLAGS.LEAF_HAS_EXT_DATA;
        }
        else {
            // remove ext_byte_length, ext_free_byte_length
            bytes.splice(extDataHeaderIndex, 8);
        }

        // update byte_length:
        const totalLeafSize = bytes.length;
        _writeByteLength(bytes, 0, totalLeafSize);

        // update free_byte_length
        _writeByteLength(bytes, 5, freeBytesLength);

        // Now, add any ext_data blocks
        if (hasExtData) {
            const leafEndIndex = bytes.length;

            moreDataBlocks.forEach(block => {
                const offset = bytes.length - leafEndIndex; // offset from leaf end index
                _writeByteLength(bytes, block.pointerIndex, offset); // update ext_data_ptr
                
                // Calculate free space
                const free = keepFreeSpace ? Math.ceil(block.bytes.length * 0.1) : 0;
                const blockLength = block.bytes.length + free;

                // ext_block_length:
                _writeByteLength(bytes, bytes.length, blockLength);

                // ext_block_free_length:
                _writeByteLength(bytes, bytes.length, free);

                // ext_data_ptr: (not implemented yet)
                bytes.push(0, 0, 0, 0);

                // data:
                _appendToArray(bytes, block.bytes);

                // Add free space:
                for (let i = 0; i < free; i++) { bytes.push(0); }
            });

            const extByteLength = bytes.length - leafEndIndex;
            const extFreeByteLength = keepFreeSpace ? Math.ceil(extByteLength * 0.1) : 0;

            // update ext_byte_length:
            _writeByteLength(bytes, extDataHeaderIndex, extByteLength + extFreeByteLength);

            // update ext_free_byte_length:
            _writeByteLength(bytes, extDataHeaderIndex + 4, extFreeByteLength);

            // Add free space:
            for (let i = 0; i < extFreeByteLength; i++) { bytes.push(0); }
        }

        return writer.append(bytes)
        .then(() => {
            return { references };
        });
    }
}

class BlacklistingSearchOperator {
    /**
     * @param {entry => []} callback callback that runs for each entry, must return an array of the entry values to be blacklist
     */
    constructor(callback) {
        this.check = callback;
    }
}

class BPlusTree {
    /**
     * 
     * @param {number} maxEntriesPerNode max number of entries per tree node. Working with this instead of m for max number of children, because that makes less sense imho
     * @param {boolean} uniqueKeys whether the keys added must be unique
     * @param {string[]} [metadataKeys] (optional) names of metadata keys that will be included in tree
     */
    constructor(maxEntriesPerNode, uniqueKeys, metadataKeys) {
        this.maxEntriesPerNode = maxEntriesPerNode;
        this.uniqueKeys = uniqueKeys;
        this.root = new BPlusTreeLeaf(this);
        this.metadataKeys = metadataKeys || [];
        this.depth = 1;
        this.fillFactor = 100;
    }

    /**
     * Adds a key to the tree
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} value data to store with the key, max size is 255
     * @param {object} [metadata] data to include, must contain all keys used in BPlusTree constructor
     * @returns {BPlusTree} returns reference to this tree
     */
    add(key, value, metadata) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        // Find the leaf to insert to
        let leaf;
        if (this.root instanceof BPlusTreeLeaf) {
            // Root is leaf node (total entries <= maxEntriesPerNode)
            leaf = this.root;
        }
        else {
            // Navigate to the right leaf to add to
            leaf = this.findLeaf(key, true);
        }
        leaf.add(key, value, metadata);
        return this;
    }

    // TODO: Enable bulk adding of keys: throw away all nodes, append/insert all keys ordered. Upon commit, cut all data into leafs, construct the nodes up onto the root
    // addBulk(arr, commit = false) {
    //     // Adds given items in bulk and reconstructs the tree
    //     let leaf = this.firstLeaf();
    //     while(leaf) {
    //         leaf = leaf.getNext()
    //     }
    // }

    /**
     * Finds the relevant leaf for a key
     * @param {string|number|boolean|Date|undefined} key 
     * @returns {BPlusTreeLeaf} returns the leaf the key is in, or would be in when present
     */
    findLeaf(key) {
        /**
         * 
         * @param {BPlusTreeNode} node 
         * @returns {BPlusTreeLeaf}
         */
        const findLeaf = (node) => { 
            if (node instanceof BPlusTreeLeaf) {
                return node;
            }
            for (let i = 0; i < node.entries.length; i++) {
                let entry = node.entries[i];
                if (_isLess(key, entry.key)) {
                    node = entry.ltChild;
                    if (!node) {
                        return null;
                    }
                    if (node instanceof BPlusTreeLeaf) {
                        return node;
                    }
                    else {
                        return findLeaf(node);
                    }
                }
            }
            // Still here? key must be >= last entry
            console.assert(_isMoreOrEqual(key, node.entries[node.entries.length-1].key));
            return findLeaf(node.gtChild);
        };
        return findLeaf(this.root);   
    }

    find(key) {
        const leaf = this.findLeaf(key);
        const entry = leaf.entries.find(entry => _isEqual(entry.key, key));
        if (!entry) { return null; }
        if (this.uniqueKeys) {
            return entry.values[0];
        }
        else {
            return entry.values;
        }
    }

    search(op, val) {
        if (["in","!in","between","!between"].indexOf(op) >= 0) {
            // val must be an array
            console.assert(val instanceof Array, `val must be an array when using operator ${op}`);
        }

        if (op === "exists" || op === "!exists") {
            op = op === "exists" ? "!=" : "==";
            val = undefined;
        }
        if (val === null) {
            val = undefined;
        }

        let results = [];
        const add = (entry) => {
            let obj = { key: entry.key };
            if (this.uniqueValues) {
                obj.value = entry.values[0];
            }
            else {
                obj.values = entry.values;
            }
            results.push(obj);
        };
        if (["<","<="].indexOf(op) >= 0) {
            let leaf = this.findLeaf(val);
            while(leaf) {
                for (let i = leaf.entries.length-1; i >= 0; i--) {
                    const entry = leaf.entries[i];
                    if (op === "<=" && _isLessOrEqual(entry.key, val)) { add(entry); }
                    else if (op === "<" && _isLess(entry.key, val)) { add(entry); }
                }
                leaf = leaf.prevLeaf;
            }
        }
        else if ([">",">="].indexOf(op) >= 0) {
            let leaf = this.findLeaf(val);
            while(leaf) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (op === ">=" && _isMoreOrEqual(entry.key, val)) { add(entry); }
                    else if (op === ">" && _isMore(entry.key, val)) { add(entry); }
                }
                leaf = leaf.nextLeaf;
            }
        }
        else if (op === "==") {
            let leaf = this.findLeaf(val);
            let entry = leaf.entries.find(entry => _isEqual(entry.key, val)); //  entry.key === val
            if (entry) {
                add(entry);
            }
        }
        else if (op === "!=") {
            // Full index scan needed
            let leaf = this.firstLeaf();
            while(leaf) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (_isNotEqual(entry.key, val)) { add(entry); } // entry.key !== val
                }
                leaf = leaf.nextLeaf;
            }
        }
        else if (op === "in") {
            let sorted = val.slice().sort();
            let searchKey = sorted.shift();
            let leaf; // = this.findLeaf(searchKey);
            let trySameLeaf = false;
            while (searchKey) {
                if (!trySameLeaf) {
                    leaf = this.findLeaf(searchKey);
                }
                let entry = leaf.entries.find(entry => _isEqual(entry.key, val)); // entry.key === searchKey
                if (!entry && trySameLeaf) {
                    trySameLeaf = false;
                    continue;
                }
                if (entry) { add(entry); }
                searchKey = sorted.shift();
                trySameLeaf = true;
            }
        }
        else if (op === "!in") {
            // Full index scan needed
            let keys = val;
            let leaf = this.firstLeaf();
            while(leaf) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (keys.findIndex(val => _isEqual(entry.key, val)) < 0) { add(entry); } //if (keys.indexOf(entry.key) < 0) { add(entry); }
                }
                leaf = leaf.nextLeaf;
            }
        }
        else if (op === "between") {
            let bottom = val[0], top = val[1];
            if (top < bottom) {
                let swap = top;
                top = bottom;
                bottom = swap;
            }
            let leaf = this.findLeaf(bottom);
            let stop = false;
            while(!stop && leaf) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (_isMoreOrEqual(entry.key, bottom) && _isLessOrEqual(entry.key, top)) { add(entry); }
                    if (_isMore(entry.key, top)) { stop = true; break; }
                }
                leaf = leaf.nextLeaf;
            }
        }
        else if (op === "!between") {
            // Equal to key < bottom || key > top
            let bottom = val[0], top = val[1];
            if (top < bottom) {
                let swap = top;
                top = bottom;
                bottom = swap;
            }
            // Add lower range first, lowest value < val < bottom
            let leaf = this.firstLeaf();
            let stop = false;
            while (leaf && !stop) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (_isLess(entry.key, bottom)) { add(entry); }
                    else { stop = true; break; }
                }
                leaf = leaf.nextLeaf;
            }
            // Now add upper range, top < val < highest value
            leaf = this.findLeaf(top);
            while (leaf) {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (_isMore(entry.key, top)) { add(entry); }
                }
                leaf = leaf.nextLeaf;
            }            
        }
        return results;
    }

    /**
     * @returns {BPlusTreeLeaf} the first leaf in the tree
     */
    firstLeaf() {
        // Get the very first leaf
        let node = this.root;
        while (!(node instanceof BPlusTreeLeaf)) {
            node = node.entries[0].ltChild;
        }
        return node;
    }

    /**
     * @returns {BPlusTreeLeaf} the last leaf in the tree
     */
    lastLeaf() {
        // Get the very last leaf
        let node = this.root;
        while (!(node instanceof BPlusTreeLeaf)) {
            node = node.gtChild;
        }        
    }

    all() {
        // Get the very first leaf
        let leaf = this.firstLeaf();
        // Now iterate through all the leafs
        const all = [];
        while (leaf) {
            all.push(...leaf.entries.map(entry => entry.key));
            leaf = leaf.nextLeaf; //leaf.next();
        }
        return all;
    }

    reverseAll() {
        // Get the very last leaf
        let leaf = this.lastLeaf();
        // Now iterate through all the leafs (backwards)
        const all = [];
        while (leaf) {
            all.push(...leaf.entries.map(entry => entry.key));
            leaf = leaf.prevLeaf;
        }
        return all;
    }

    static get debugBinary() { return false; }
    static addBinaryDebugString(str, byte) {
        if (this.debugBinary) {
            return [str, byte];
        }
        else {
            return byte;
        }
    }
    static getKeyFromBinary(bytes, index) {
        // key_type:
        let keyType = bytes[index];
        index++;

        // key_length:
        let keyLength = bytes[index];
        index++;

        // key_data:
        let keyData = bytes.slice(index, index + keyLength); // [];
        index += keyLength;

        if (keyType === KEY_TYPE.NUMBER || keyType === KEY_TYPE.DATE) {
            keyData = Array.from(keyData);
        }

        let key;
        switch(keyType) {
            case KEY_TYPE.UNDEFINED: {
                // no need to do this: key = undefined;
                break;
            }
            case KEY_TYPE.STRING: {
                key = decodeString(keyData); // textDecoder.decode(Uint8Array.from(keyData));
                // key = keyData.reduce((k, code) => k + String.fromCharCode(code), "");
                break;
            }
            case KEY_TYPE.NUMBER: {
                if (keyData.length < 8) {
                    // Append trailing 0's
                    keyData.push(...[0,0,0,0,0,0,0,0].slice(keyData.length));
                }
                key = bytesToNumber(keyData);
                break;
            }
            case KEY_TYPE.BOOLEAN: {
                key = keyData[0] === 1;
                break;
            }
            case KEY_TYPE.DATE: {
                key = new Date(bytesToNumber(keyData));
                break;
            }
            default: {
                throw new DetailedError('unknown-key-type', `Unknown key type ${keyType}`);
            }
        }
        return { key, length: keyLength, byteLength: keyLength + 2 };
    }
    static getBinaryKeyData(key) {
        // TODO: Deprecate, moved to BinaryBPlusTreeBuilder.getKeyBytes
        let keyBytes = [];
        let keyType = KEY_TYPE.UNDEFINED;
        switch(typeof key) {
            case "undefined": {
                keyType = KEY_TYPE.UNDEFINED;
                break;
            }                
            case "string": {
                keyType = KEY_TYPE.STRING;
                keyBytes = Array.from(encodeString(key)); // textEncoder.encode(key)
                break;
            }
            case "number": {
                keyType = KEY_TYPE.NUMBER;
                keyBytes = numberToBytes(key);
                // Remove trailing 0's to reduce size for smaller and integer values
                while (keyBytes[keyBytes.length-1] === 0) { keyBytes.pop(); }
                break;
            }
            case "boolean": {
                keyType = KEY_TYPE.BOOLEAN;
                keyBytes = [key ? 1 : 0];
                break;
            }
            case "object": {
                if (key instanceof Date) {
                    keyType = KEY_TYPE.DATE;
                    keyBytes = numberToBytes(key.getTime());
                }
                else {
                    throw new DetailedError('invalid-object-key-type', `Unsupported object key type`);
                }
                break;
            }
            default: {
                throw new DetailedError('invalid-key-type', `Unsupported key type: ${typeof key}`);
            }
        }

        const bytes = [];

        // key_type:
        bytes.push(keyType);

        // key_length:
        bytes.push(keyBytes.length);

        // key_data:
        bytes.push(...keyBytes);

        return bytes;
    }

    /**
     * BPlusTree.toBinary
     * @param {boolean} keepFreeSpace 
     * @param {BinaryWriter} writer
     */
    toBinary(keepFreeSpace = false, writer) {
        // TODO: Refactor to use BinaryBPlusTreeBuilder, .getHeader()
        if (!(writer instanceof BinaryWriter)) {
            throw new Error(`writer argument must be an instance of BinaryWriter`);
        }
        // Return binary data
        const indexTypeFlags = 
              (this.uniqueKeys ? FLAGS.UNIQUE_KEYS : 0) 
            | (this.metadataKeys.length > 0 ? FLAGS.HAS_METADATA : 0)
            | (keepFreeSpace ? FLAGS.HAS_FREE_SPACE : 0)
            | FLAGS.HAS_FILL_FACTOR
            | (WRITE_SMALL_LEAFS ? FLAGS.HAS_SMALL_LEAFS : 0)
            | FLAGS.HAS_LARGE_PTRS;
        const bytes = [
            // byte_length:
            0, 0, 0, 0,
            // index_type:
            indexTypeFlags,
            // max_node_entries:
            this.maxEntriesPerNode,
            // fill_factor:
            this.fillFactor
        ];
        if (keepFreeSpace) {
            bytes.push(0, 0, 0, 0); // free_byte_length
        }
        if (this.metadataKeys.length > 0) {
            // metadata_keys:
            const index = bytes.length;
            bytes.push(0, 0, 0, 0); // metadata_length

            // metadata_key_count:
            bytes.push(this.metadataKeys.length);

            this.metadataKeys.forEach(key => {
                // metadata_key:
                bytes.push(key.length); // metadata_key_length
                // metadata_key_name:
                for (let i=0; i < key.length; i++) {
                    bytes.push(key.charCodeAt(i));
                }
            });

            // update metadata_length:
            const length = bytes.length - index - 4;
            // bytes[index] = (length >> 24) & 0xff;
            // bytes[index+1] = (length >> 16) & 0xff;
            // bytes[index+2] = (length >> 8) & 0xff;
            // bytes[index+3] = length & 0xff;
            _writeByteLength(bytes, index, length);

        }

        const headerLength = bytes.length;
        return writer.append(bytes)
        .then(() => {
            return this.root.toBinary(keepFreeSpace, writer);
        })
        .then(({ references, pointers }) => {
            console.assert(references.length === 0, "All references must be resolved now");

            if (keepFreeSpace) {
                // Add 10% free space
                const freeSpaceLength = Math.ceil((writer.length - headerLength) * 0.1);
                const bytesPerWrite = 1024 * 100; // 100KB per write seems fair?
                const writes = Math.ceil(freeSpaceLength / bytesPerWrite);

                var writePromise = Promise.resolve();
                for (let i = 0; i < writes; i++) {
                    const length = i + 1 < writes
                        ? bytesPerWrite
                        : freeSpaceLength % bytesPerWrite;
                    const zeroes = new Uint8Array(length);
                    writePromise = writePromise.then(() => {
                        return writer.append(zeroes);
                    });
                }
                
                return writePromise.then(() => freeSpaceLength);
            }

            return 0;
        })
        .then(freeBytesLength => {

            // update byte_length:
            const byteLength = writer.length; // - headerLength;
            // const bytes = [
            //     (byteLength >> 24) & 0xff,
            //     (byteLength >> 16) & 0xff,
            //     (byteLength >> 8) & 0xff,
            //     byteLength & 0xff
            // ];
            const bytes = _writeByteLength([], 0, byteLength);

            return writer.write(bytes, 0)
            .then(() => {
                if (keepFreeSpace) {
                    // update free_byte_length:
                    // const bytes = [
                    //     (freeBytesLength >> 24) & 0xff,
                    //     (freeBytesLength >> 16) & 0xff,
                    //     (freeBytesLength >> 8) & 0xff,
                    //     freeBytesLength & 0xff
                    // ];
                    const bytes = _writeByteLength([], 0, freeBytesLength);
                    return writer.write(bytes, 7);
                }
            });
        })
        .then(() => {
            return writer.end();
        });
    }

    static get typeSafeComparison() {
        return {
            isMore(val1, val2) { return _isMore(val1, val2); },
            isMoreOrEqual(val1, val2) { return isMoreOrEqual(val1, val2); },
            isLess(val1, val2) { return _isLess(val1, val2); },
            isLessOrEqual(val1, val2) { return _isLessOrEqual(val1, val2); },
            isEqual(val1, val2) { return _isEqual(val1, val2); },
            isNotEqual(val1, val2) { return _isNotEqual(val1, val2); }
        };
    }
}

function _checkNewEntryArgs(key, recordPointer, metadataKeys, metadata) {
    const storageTypesText = 'supported types are string, number, boolean, Date and undefined';
    const isStorableType = (val) => {
        return ['number','string','boolean','undefined'].indexOf(typeof val) >= 0 || val instanceof Date;
    };
    if (!isStorableType(key)) {
        return new TypeError(`key contains a value that cannot be stored. ${storageTypesText}`);
    }
    if (!(recordPointer instanceof Array || recordPointer instanceof Uint8Array)) {
        return new TypeError("recordPointer must be a byte array or Uint8Array");
    }
    if (recordPointer.length > 255) {
        return new Error(`Unable to store recordPointers larger than 255 bytes`); // binary restriction
    }
    // Check if all metadata keys are present and have valid data
    try {
        metadataKeys && metadataKeys.forEach(key => {
            if (!(key in metadata)) { 
                throw new TypeError(`metadata must include key "${key}"`); 
            }
            if (!isStorableType(typeof metadata[key])) {
                throw new TypeError(`metadata "${key}" contains a value that cannot be stored. ${storageTypesText}`);
            }
        });
    }
    catch(err) {
        return err;
    }
}

class BPlusTreeBuilder {
    /**
     * @param {boolean} uniqueKeys
     * @param {number} [fillFactor=100]
     * @param {string[]} [metadataKeys=[]]
     */
    constructor(uniqueKeys, fillFactor = 100, metadataKeys = []) {
        this.uniqueKeys = uniqueKeys;
        this.fillFactor = fillFactor;
        this.metadataKeys = metadataKeys || [];
        this.list = new Map(); // {};
        this.indexedValues = 0;
    }

    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer 
     * @param {object} [metadata] 
     */
    add(key, recordPointer, metadata) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        const err = _checkNewEntryArgs(key, recordPointer, this.metadataKeys, metadata);
        if (err) {
            throw err;
        }
        const entryValue = new BPlusTreeLeafEntryValue(recordPointer, metadata);
        const existing = this.list.get(key); // this.list[key]
        if (this.uniqueKeys && typeof existing !== 'undefined') {
            throw new DetailedError('unique-key-violation', `Cannot add duplicate key "${key}", tree must have unique keys`);
        }
        else if (existing) {
            existing.push(entryValue);
        }
        else {
            this.list.set(key, this.uniqueKeys //this.list[key] =
                ? entryValue
                : [entryValue]);
        }
        this.indexedValues++;
    }

    /**
     * 
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} [recordPointer] specific recordPointer to remove. If the tree has unique keys, this can be omitted
     */
    remove(key, recordPointer = undefined) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        const isEqual = (val1, val2) => {
            if (val1 instanceof Array && val2 instanceof Array) {
                return val1.every((v,i) => val2[i] === v);
            }
            return val1 === val2;
        };
        if (this.uniqueKeys) {
            this.list.delete(key); //delete this.list[key];
        }
        else {
            const entryValues = this.list.get(key); //[key]
            const valIndex = entryValues.findIndex(entryValue => isEqual(entryValue.recordPointer, recordPointer));
            if (~valIndex) {
                if (item.length === 1) {
                    this.list.delete(key); //delete this.list[key];
                }
                else {
                    entryValues.splice(valIndex, 1);
                }
            }
        }
    }

    create(maxEntries = undefined) {
        // Create a tree bottom-up with all nodes filled to the max (optionally capped to fillFactor)

        let list = [];
        this.list.forEach((val, key) => {
            list.push({ key, val });
        });
        this.list.clear();
        this.list = null; // Make unusable
        list.sort((a,b) => {
            return _sortCompare(a.key, b.key);
            // if (_isLess(a.key, b.key)) { return -1; }
            // else if (_isMore(a.key, b.key)) { return 1; }
            // return 0;
        });

        //const length = Object.keys(this.list).length;
        const minNodeSize = 3; //25;
        const maxNodeSize = 255;
        const entriesPerNode = typeof maxEntries === 'number' ? maxEntries : Math.min(maxNodeSize, Math.max(minNodeSize, Math.ceil(list.length / 10)));
        const entriesPerLeaf = Math.max(minNodeSize, Math.floor(entriesPerNode * (this.fillFactor / 100)));
        const minParentEntries = Math.max(1, Math.floor(entriesPerNode / 2));
        const tree = new BPlusTree(entriesPerNode, this.uniqueKeys, this.metadataKeys);
        tree.fillFactor = this.fillFactor;

        const nrOfLeafs = Math.max(1, Math.ceil(list.length / entriesPerLeaf));
        const parentConnections = entriesPerNode+1;  // should be +1 because the > connection
        let currentLevel = 1;
        let nrOfNodesAtLevel = nrOfLeafs;
        let nrOfParentNodes = Math.ceil(nrOfNodesAtLevel / parentConnections);
        let nodesAtLevel = [];
        while (true) {
            // Create parent nodes
            const creatingLeafs = currentLevel === 1;
            const parentNodes = [];
            for (let i = 0; i < nrOfParentNodes; i++) {
                const node = new BPlusTreeNode(tree, null);
                if (i > 0) { 
                    const prevNode = parentNodes[i-1];
                    node.prevNode = prevNode;
                    prevNode.nextNode = node;
                }
                parentNodes.push(node);
            }

            for (let i = 0; i < nrOfNodesAtLevel; i++) {
                // Eg 500 leafs with 25 entries each, 500/25 = 20 parent nodes:
                // When i is between 0 and (25-1), parent node index = 0
                // When i is between 25 and (50-1), parent index = 1 etc
                // So, parentIndex = Math.floor(i / 25)
                const parentIndex = Math.floor(i / parentConnections); 
                const parent = parentNodes[parentIndex];

                if (creatingLeafs) {
                    // Create leaf
                    const leaf = new BPlusTreeLeaf(parent);
                    nodesAtLevel.push(leaf);

                    // Setup linked list properties
                    const prevLeaf = nodesAtLevel[nodesAtLevel.length-2];
                    if (prevLeaf) {
                        leaf.prevLeaf = prevLeaf;
                        prevLeaf.nextLeaf = leaf;
                    }

                    // Create leaf entries
                    const fromIndex = i * entriesPerLeaf;
                    const entryKVPs = list.slice(fromIndex, fromIndex + entriesPerLeaf);
                    entryKVPs.forEach(kvp => {
                        const entry = new BPlusTreeLeafEntry(leaf, kvp.key);
                        entry.values = this.uniqueKeys ? [kvp.val] : kvp.val;
                        leaf.entries.push(entry);
                    });
                    
                    const isLastLeaf = Math.floor((i+1) / parentConnections) > parentIndex 
                        || i === nrOfNodesAtLevel-1;
                    if (isLastLeaf) {
                        // Have parent's gtChild point to this last leaf
                        parent.gtChild = leaf;

                        if (parentNodes.length > 1 && parent.entries.length < minParentEntries) {
                            /* Consider this order 4 B+Tree: 3 entries per node, 4 connections

                                                    12  >
                                            4  7  10 >	  ||	>
                                1  2  3 || 4  5  6 || 7  8  9 || 10  11  12 || 13 14 15

                                The last leaf (13 14 15) is the only child of its parent, its assignment to
                                parent.gtChild is right, but there is no entry to > compare to. In this case, we have to
                                move the previous leaf's parent entry to our own parent:

                                                    10  >
                                            4  7  >	   ||	13  >
                                1  2  3 || 4  5  6 || 7  8  9 || 10  11  12 || 13 14 15

                                We moved just 1 parent entry which is fine in case of an order 4 tree, floor((O-1) / 2) is the 
                                minimum entries for a node, floor((4-1) / 2) = floor(1.5) = 1.
                                When the tree order is higher, it's effect on higher tree nodes becomes greater and the tree 
                                becomes inbalanced if we do not meet the minimum entries p/node requirement. 
                                So, we'll have to move Math.floor(entriesPerNode / 2) parent entries to our parent
                            */
                            const nrOfParentEntries2Move = minParentEntries - parent.entries.length;
                            const prevParent = parent.prevNode;
                            for (let j = 0; j < nrOfParentEntries2Move; j++) {
                                const firstChild = parent.entries.length === 0 
                                    ? leaf                                      // In first iteration, firstLeaf === leaf === "13 14 15"
                                    : parent.entries[0].ltChild;                // In following iterations, firstLeaf === last moved leaf "10 11 12"
                                //const prevChild = firstChild.prevChild;
                                const moveEntry = prevParent.entries.pop();     // removes "10" from prevLeaf's parent
                                const moveLeaf = prevParent.gtChild;
                                prevParent.gtChild = moveEntry.ltChild;         // assigns "7 8 9" leaf to prevLeaf's parent > connection
                                moveEntry.key = firstChild.entries[0].key;      // changes the key to "13"
                                moveLeaf.parent = parent;                       // changes moving "10 11 12" leaf's parent to ours
                                moveEntry.ltChild = moveLeaf;                   // assigns "10 11 12" leaf to <13 connection
                                parent.entries.unshift(moveEntry);              // inserts "13" entry into our parent node
                                moveEntry.node = parent;                      // changes moving entry's parent to ours
                            }
                            //console.log(`Moved ${nrOfParentEntries2Move} parent node entries`);
                        }
                    }
                    else {
                        // Create parent entry with ltChild that points to this leaf
                        const ltChildKey = list[fromIndex + entriesPerLeaf].key;
                        const parentEntry = new BPlusTreeNodeEntry(parent, ltChildKey);
                        parentEntry.ltChild = leaf;
                        parent.entries.push(parentEntry);
                    }
                }
                else {
                    // Nodes have already been created at the previous iteration,
                    // we have to create entries for parent nodes only
                    const node = nodesAtLevel[i];
                    node.parent = parent;

                    // // Setup linked list properties - not needed by BPlusTreeNode itself, but used in code below
                    // const prevNode = nodesAtLevel[nodesAtLevel.length-2];
                    // if (prevNode) {
                    //     node.prevNode = prevNode;
                    //     prevNode.nextNode = node;
                    // }

                    const isLastNode = Math.floor((i+1) / parentConnections) > parentIndex
                        || i === nrOfNodesAtLevel-1;
                    if (isLastNode) {
                        parent.gtChild = node;

                        if (parentNodes.length > 1 && parent.entries.length < minParentEntries) {
                            // This is not right, we have to fix it.
                            // See leaf code above for additional info
                            const nrOfParentEntries2Move = minParentEntries - parent.entries.length;
                            const prevParent = parent.prevNode;
                            for (let j = 0; j < nrOfParentEntries2Move; j++) {
                                const firstChild = parent.entries.length === 0 
                                    ? node
                                    : parent.entries[0].ltChild;
                                
                                const moveEntry = prevParent.entries.pop();
                                const moveNode = prevParent.gtChild;
                                prevParent.gtChild = moveEntry.ltChild;
                                let ltChild = firstChild.entries[0].ltChild;
                                while (!(ltChild instanceof BPlusTreeLeaf)) {
                                    ltChild = ltChild.entries[0].ltChild;
                                }
                                moveEntry.key = ltChild.key; //firstChild.entries[0].key;
                                moveNode.parent = parent;
                                moveEntry.ltChild = moveNode;
                                parent.entries.unshift(moveEntry);
                                moveEntry.node = parent;
                            }
                            //console.log(`Moved ${nrOfParentEntries2Move} parent node entries`);
                        }
                    }
                    else {
                        let ltChild = node.nextNode;
                        while (!(ltChild instanceof BPlusTreeLeaf)) {
                            ltChild = ltChild.entries[0].ltChild;
                        }
                        const ltChildKey = ltChild.entries[0].key; //node.gtChild.entries[node.gtChild.entries.length-1].key; //nodesAtLevel[i+1].entries[0].key;
                        const parentEntry = new BPlusTreeNodeEntry(parent, ltChildKey);
                        parentEntry.ltChild = node;
                        parent.entries.push(parentEntry);
                    }
                }
            }

            if (nrOfLeafs === 1) {
                // Very little data. Only 1 leaf
                let leaf = nodesAtLevel[0];
                leaf.parent = tree;
                tree.root = leaf;
                break;
            }
            else if (nrOfParentNodes === 1) {
                // Done
                tree.root = parentNodes[0];
                break;
            }
            currentLevel++; // Level up
            nodesAtLevel = parentNodes;
            nrOfNodesAtLevel = nodesAtLevel.length;
            nrOfParentNodes = Math.ceil(nrOfNodesAtLevel / parentConnections);
            tree.depth++;
        }

        if (false) {
            // TEST the tree!
            const ok = list.every(item => {
                const val = tree.find(item.key);
                if (val === null) {
                    return false;
                }
                return true;
                //return  !== null;
            })
            if (!ok) {
                throw new Error(`This tree is not ok`);
            }
        }

        return tree;
    }

    dumpToFile(filename) {
        const fs = require('fs');
        fs.appendFileSync(filename, this.uniqueKeys + '\n');
        fs.appendFileSync(filename, this.fillFactor + '\n');
        for (let [key, val] of this.list) {
            let json = JSON.stringify({ key, val }) + '\n';
            fs.appendFileSync(filename, json);
        }
    }

    static fromFile(filename) {
        const fs = require('fs');
        const entries = fs.readFileSync(filename, 'utf8')
            .split('\n')
            .map(str => str.length > 0 ? JSON.parse(str) : '');

        const last = entries.pop(); // Remove last empty one (because split \n)
        console.assert(last === '');
        const uniqueKeys = entries.shift() === 'true';
        const fillFactor = parseInt(entries.shift());
        let builder = new BPlusTreeBuilder(uniqueKeys, fillFactor);
        // while(entries.length > 0) {
        //     let entry = entries.shift();
        //     builder.list.set(entry.key, entry.val);
        // }
        for (let i = 0; i < entries.length; i++) {
            builder.list.set(entries[i].key, entries[i].val);
        }
        return builder;
    }
}

// TODO: Refactor to typed arrays
class ChunkReader {
    constructor(chunkSize, readFn) {
        this.chunkSize = chunkSize;
        this.read = readFn;
        this.data = null;
        this.offset = 0;    // offset of loaded data (start index of current chunk in data source)
        this.index = 0;     // current chunk reading index ("cursor" in currently loaded chunk)
    }
    clone() {
        const clone = Object.assign(new ChunkReader(this.chunkSize, this.read), this);
        clone.offset = 0;
        clone.index = 0;
        clone.data = [];
        return clone;
    }
    init() {
        return this.read(0, this.chunkSize)
        .then(chunk => {
            this.data = chunk;
            this.offset = 0;
            this.index = 0;
            return this;
        });
    }
    get(byteCount) {
        return this.assert(byteCount)
        .then(() => {
            const bytes = this.data.slice(this.index, this.index + byteCount);
            this.index += byteCount;
            return bytes;
        });
    }
    more(chunks = 1) {
        return this.read(this.offset + this.data.length, chunks * this.chunkSize)
        .then(nextChunk => {
            //this.data.push(...nextChunk);
            //nextChunk.forEach(byte => this.data.push(byte));
            this.data = this.data.concat(Array.from(nextChunk));
            return this;
        });
    }
    seek(offset) {
        if (this.index + offset < this.data.length) {
            this.index += offset;
            return Promise.resolve();
        }
        let dataIndex = this.offset + this.index + offset;
        return this.read(dataIndex, this.chunkSize)
        .then(newChunk => {
            this.data = newChunk;
            this.offset = dataIndex;
            this.index = 0;
            return this;
        });        
    }
    assert(byteCount) {
        if (this.index + byteCount > this.data.length) {
            return this.more(Math.ceil(byteCount / this.chunkSize));
        }
        else {
            return Promise.resolve(this);
        }        
    }
    skip(byteCount) {
        this.index += byteCount;
        return this;
    }
    rewind(byteCount) {
        this.index -= byteCount;
        return this;
    }
    go(index) {
        if (this.offset <= index && this.offset + this.data.length > index) {
            this.index = index - this.offset;
            return Promise.resolve(this);
        }
        return this.read(index, this.chunkSize)
        .then(chunk => {
            this.data = chunk;
            this.offset = index;
            this.index = 0;
            return this;
        });
    }
    savePosition(offsetCorrection = 0) {
        let savedIndex = this.offset + this.index + offsetCorrection;
        let go = (offset = 0) => {
            let index = savedIndex + offset;
            return this.go(index);
        }
        return {
            go,
            index: savedIndex
        };
    }
    get sourceIndex() {
        return this.offset + this.index;
    }
}

class BinaryBPlusTree {
    /**
     * Provides functionality to read and search in a B+tree from a binary data source
     * @param {Array|(index: number, length: number) => Promise<Array>} readFn byte array, or function that reads from your data source, must return a promise that resolves with a byte array (the bytes read from file/memory)
     * @param {number} [chunkSize] numbers of bytes per chunk to read at once
     * @param {(data: number[], index: number) => Promise<any>} [writeFn] function that writes to your data source, must return a promise that resolves once write has completed
     * @param {string} [id] to edit the tree, pass a unique id to enable "thread-safe" locking
     */
    constructor(readFn, chunkSize = 1024, writeFn = undefined, id = undefined) {
        this._chunkSize = chunkSize;
        this._autoGrow = false;
        this.id = id;
        if (readFn instanceof Array) {
            let data = readFn;
            if (BPlusTree.debugBinary) {
                this.debugData = data;
                data = data.map(entry => entry instanceof Array ? entry[1] : entry);
            }
            this._readFn = (i, length) => {
                let slice = data.slice(i, i + length);
                return Promise.resolve(Buffer.from(slice));
            };
        }
        else if (typeof readFn === "function") {
            this._readFn = readFn;
        }
        else {
            throw new TypeError(`readFn must be a byte array or function that reads from a data source`);
        }

        if (typeof writeFn === "function") {
            this._writeFn = writeFn;
            // // TEST:
            // this._writeFn = (data, index) => {
            //     const freeSpaceStartIndex = this.info.byteLength;
            //     console.assert(index + data.length < freeSpaceStartIndex, 'writing in free space!');
            //     return writeFn(data, index);
            // }
        }
        else if (typeof writeFn === "undefined" && readFn instanceof Array) {
            const sourceData = readFn;
            this._writeFn = (data, index) => {
                for (let i = 0; i < data.length; i++) {
                    sourceData[index + i] = data[i];
                }
                return Promise.resolve();
            }
        }
        else {
            this._writeFn = () => {
                throw new Error(`Cannot write data, no writeFn was supplied`);
            }
        }
    }

    static test(data) {
        const tree = new BinaryBPlusTree(data);

        const testLeaf = leaf => {
            let i = 0;
            const nextEntry = () => {
                const entry = leaf.entries[i];                
                return tree.find(entry.key)
                .then(found => {
                    i++;
                    return i < leaf.entries.length ? nextEntry() : null;
                });
            }
            return nextEntry()
            .then(() => {
                if (leaf.getNext) { return leaf.getNext().then(testLeaf); } 
            })
        };

        return tree.getFirstLeaf()
        .then(testLeaf);
    }

    get autoGrow() {
        return this._autoGrow;
    }
    set autoGrow(grow) {
        this._autoGrow = grow === true;
        if (this._autoGrow) {
            console.warn('autoGrow enabled for binary tree');
        }
    }

    /**
     * @returns {Promise<BinaryReader>}
     */
    _getReader() {
        const reader = new BinaryReader(this._readFn, this._chunkSize); // new ChunkReader(this._chunkSize, this._readFn);
        return reader.init()
        .then(() => {
            return reader.get(6);
        })
        .then(header => {
            const originalByteLength = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
            if (!this._originalByteLength) {
                this._originalByteLength = originalByteLength;
            }
            this.info = {
                headerLength: 6,
                byteLength: originalByteLength,
                isUnique: (header[4] & FLAGS.UNIQUE_KEYS) > 0,
                hasMetadata: (header[4] & FLAGS.HAS_METADATA) > 0,
                hasFreeSpace: (header[4] & FLAGS.HAS_FREE_SPACE) > 0,
                hasFillFactor: (header[4] & FLAGS.HAS_FILL_FACTOR) > 0,
                hasSmallLeafs: (header[4] & FLAGS.HAS_SMALL_LEAFS) > 0,
                hasLargePtrs: (header[4] & FLAGS.HAS_LARGE_PTRS) > 0,
                freeSpace: 0,
                get freeSpaceIndex() { return this.hasFillFactor ? 7 : 6; },
                entriesPerNode: header[5],
                fillFactor: 100,
                metadataKeys: []
            };
            // if (!this.info.hasLargePtrs) {
            //     console.warn(`Warning: tree "${this.id}" is read-only because it contains small ptrs. it needs to be rebuilt`);
            // }
            let additionalHeaderBytes = 0;
            if (this.info.hasFillFactor) { additionalHeaderBytes += 1; }
            if (this.info.hasFreeSpace) { additionalHeaderBytes += 4; }
            if (this.info.hasMetadata) { additionalHeaderBytes += 4; }

            if (additionalHeaderBytes > 0) {
                // The tree has fill factor, free space, and/or metadata keys, read them
                this.info.headerLength += additionalHeaderBytes;
                return reader.get(additionalHeaderBytes)
                .then(bytes => {
                    let i = 0;
                    if (this.info.hasFillFactor) {
                        this.info.fillFactor = bytes[i];                         
                        i++;
                    }
                    if (this.info.hasFreeSpace) {
                        this.info.freeSpace = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]; 
                        i += 4;
                    }
                    if (this.info.hasMetadata) {
                        const length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]; 
                        this.info.headerLength += length;
                        return reader.get(length);
                    }
                })
                .then(bytes => {
                    if (!bytes) { return reader; }

                    const keyCount = bytes[0];
                    let index = 1;
                    for (let i = 0; i < keyCount; i++) {
                        const keyLength = bytes[index];
                        index++;
                        let key = '';
                        for (let j = 0; j < keyLength; j++) {
                            key += String.fromCharCode(bytes[index+j]);
                        }
                        index += keyLength;
                        this.info.metadataKeys.push(key);
                    }

                    // Done reading header
                    return reader;
                });
            }
            // Done reading header
            return reader;
        });
    }

    /**
     * 
     * @param {BinaryReader} reader 
     * @returns {Promise<BinaryBPlusTreeNodeInfo>}
     */
    _readChild(reader) {
        const index = reader.sourceIndex; //reader.savePosition().index;
        const headerLength = 9;
        return reader.get(headerLength) // byte_length, is_leaf, free_byte_length
        .then(bytes => {
            const byteLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]; // byte_length
            const isLeaf = (bytes[4] & FLAGS.IS_LEAF) > 0; // is_leaf
            const hasExtData = (bytes[4] & FLAGS.LEAF_HAS_EXT_DATA) > 0; // has_ext_data
            const freeBytesLength = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];

            // load whole node/leaf for easy processing
            const dataLength = byteLength - headerLength - freeBytesLength
            return reader.get(dataLength)
            .then(bytes => {
                console.assert(bytes.length === dataLength, 'less bytes read than requested?');
                const childInfo = new BinaryBPlusTreeNodeInfo({
                    tree: this,
                    isLeaf,
                    hasExtData,
                    bytes,
                    sourceIndex: index,
                    dataIndex: index + headerLength,
                    length: byteLength,
                    free: freeBytesLength
                });
                return childInfo;
            });
        });
    }

    /**
     * 
     * @param {BinaryBPlusTreeNodeInfo} leafInfo
     * @param {ChunkReader} reader 
     * @param {object} [options]
     * @param {boolean} [options.stats=false]
     * @returns {BinaryBPlusTreeLeaf}
     */
    _getLeaf(leafInfo, reader, options) {
        const leaf = new BinaryBPlusTreeLeaf(leafInfo);
        const bytes = leaf.bytes;
        const savedPosition = reader.savePosition(-bytes.length);

        const prevLeafOffset = _readSignedOffset(bytes, 0, this.info.hasLargePtrs); // prev_leaf_ptr
        let index = this.info.hasLargePtrs ? 6 : 4;
        const nextLeafOffset = _readSignedOffset(bytes, index, this.info.hasLargePtrs); // next_leaf_ptr
        index += this.info.hasLargePtrs ? 6 : 4;
        leaf.prevLeafOffset = prevLeafOffset;
        leaf.nextLeafOffset = nextLeafOffset;

        if (leafInfo.hasExtData) {
            leaf.extData.length = _readByteLength(bytes, index);
            leaf.extData.freeBytes = _readByteLength(bytes, index + 4);
            index += 8;

            leaf.extData.load = () => {
                // Load all extData blocks. Needed when eg rebuilding
                if (leaf.extData.loaded) { 
                    return Promise.resolve(); 
                }

                const index = leaf.sourceIndex + leaf.length;
                const length = leaf.extData.length - leaf.extData.freeBytes;
                const r = reader.clone();
                r.chunkSize = length; // So it will be 1 read
                return r.go(index)
                .then(() => {
                    return r.get(length);
                })
                .then(bytes => {
                    leaf.entries.forEach(entry => {
                        if (entry.extData) {
                            entry.extData.loadFromExtData(bytes);
                        }
                    });
                    leaf.extData.loaded = true;
                });
            }
        }

        let entriesLength = bytes[index]; // entries_length
        index++;

        const readValue = () => {
            let result = readEntryValue(bytes, index);
            index += result.byteLength;
            return result.entryValue;
        };
        const readEntryValue = (bytes, index) => {
            console.assert(index < bytes.length, 'invalid data');
            if (index >= bytes.length) {
                throw new Error('invalid data');
            }
            const startIndex = index;
            let valueLength = bytes[index]; // value_length
            console.assert(index + valueLength < bytes.length, 'not enough data!');
            index++;
            let value = [];
            // value_data:
            for (let j = 0; j < valueLength; j++) {
                value[j] = bytes[index + j];
            }
            index += valueLength;

            // metadata:
            const metadata = this.info.hasMetadata ? {} : undefined;
            this.info.metadataKeys.forEach(key => {
                // metadata_value:
                // NOTE: it seems strange to use getKeyFromBinary to read a value, but metadata_value is stored in the same way as a key, so this comes in handy
                let valueInfo = BPlusTree.getKeyFromBinary(bytes, index);
                metadata[key] = valueInfo.key;
                index += valueInfo.byteLength;
            });
            return {
                entryValue: new BinaryBPlusTreeLeafEntryValue(value, metadata),
                byteLength: index - startIndex
            };
        };

        for (let i = 0; i < entriesLength; i++) {
            let keyInfo = BPlusTree.getKeyFromBinary(bytes, index);
            let key = keyInfo.key;
            index += keyInfo.byteLength;

            // Read value(s) and return
            const hasExtData = this.info.hasSmallLeafs && (bytes[index] & FLAGS.ENTRY_HAS_EXT_DATA) > 0;
            let valLength = this.info.hasSmallLeafs
                ? hasExtData ? 0 : bytes[index]
                :  (bytes[index] << 24) | (bytes[index+1] << 16) | (bytes[index+2] << 8) | bytes[index+3]; // val_length
            index += this.info.hasSmallLeafs
                ? 1
                : 4;
            if (options && options.stats) {
                // Skip values, only load value count
                let entry = new BinaryBPlusTreeLeafEntry(key, null);
                if (this.info.isUnique) { 
                    entry.totalValues = 1;
                }
                else {
                    entry.totalValues = (bytes[index] << 24) | (bytes[index+1] << 16) | (bytes[index+2] << 8) | bytes[index+3]; // value_list_length
                }
                leaf.entries.push(entry);
                if (hasExtData) {
                    index += this.info.isUnique ? 4 : 8; // skip ext_data_ptr (and value_list_length if not unique)
                }
                else {
                    index += valLength; // skip value
                }
            }
            else if (this.info.isUnique) {
                // Read single value
                const entryValue = readValue();
                leaf.entries.push(new BinaryBPlusTreeLeafEntry(key, [entryValue]));
            }
            else {
                // Read value_list_length
                const valuesListLengthIndex = leafInfo.dataIndex + index;
                let valuesLength = (bytes[index] << 24) | (bytes[index+1] << 16) | (bytes[index+2] << 8) | bytes[index+3]; // value_list_length
                index += 4;
                if (hasExtData) {
                    // additional data will have to be loaded upon request
                    // ext_data_ptr:
                    const extDataOffset = _readByteLength(bytes, index);
                    index += 4;
                    const extDataBlockIndex = leafInfo.sourceIndex + leafInfo.length + extDataOffset;
                    const entry = new BinaryBPlusTreeLeafEntry(key, new Array(valuesLength));
                    const tree = this;
                    Object.defineProperties(entry, {
                        values: {
                            get() { 
                                return this.extData.values;
                            },
                            set(values) {
                                this.extData.values = values;
                            }
                        },
                        extData: {
                            value: {
                                _headerLoaded: false,
                                _length: -1,
                                _freeBytes: -1,
                                _values: null,
                                _listLengthIndex: valuesListLengthIndex,
                                get length() { 
                                    if (this._headerLoaded) { return this._length; } 
                                    throw new Error(`ext_data header not read yet`);
                                },
                                get freeBytes() { 
                                    if (this._headerLoaded) { return this._freeBytes; } 
                                    throw new Error(`ext_data header not read yet`);
                                },
                                get values() {
                                    if (this._values !== null) { return this._values; }
                                    throw new Error('ext_data values were not read yet. use entry.extData.loadValues() first')
                                },
                                set values(values) {
                                    this._values = values;
                                },
                                leafOffset: extDataOffset,
                                index: extDataBlockIndex,
                                get totalValues() { return valuesLength; },
                                set totalValues(n) { valuesLength = n; },
                                get loaded() { return this._values !== null; },
                                get _headerLength() { return 8; },
                                loadValues() {
                                    // load all values
                                    // reader = reader.clone();
                                    return this.loadHeader(true)
                                    .then(lock => {
                                        return reader.go(this.index + this._headerLength)
                                        .then(() => {
                                            return reader.get(this._length - this._freeBytes);
                                        })
                                        .then(extData => {
                                            this._values = [];
                                            let index = 0;
                                            for(let i = 0; i < valuesLength; i++) {
                                                const result = readEntryValue(extData, index);
                                                index += result.byteLength;
                                                this._values.push(result.entryValue);
                                            }
                                            this.totalValues = valuesLength;
                                            return this._values;  
                                        })
                                        .then(values => {
                                            lock.release();
                                            return values;
                                        });
                                    });
                                },
                                loadHeader(keepLock = false) {
                                    // if (this._headerLoaded) {
                                    //     return keepLock ? ThreadSafe.lock(leaf) : Promise.resolve(null);
                                    // }
                                    reader = reader.clone();
                                    // load header
                                    return ThreadSafe.lock(leaf)
                                    .then(lock => {
                                        return reader.go(extDataBlockIndex)
                                        .then(() => {
                                            return reader.get(this._headerLength); // ext_data_length, ext_free_byte_length, ext_data_ptr
                                        })
                                        .then(extHeader => {
                                            this._headerLoaded = true;
                                            this._length = _readByteLength(extHeader, 0);
                                            this._freeBytes = _readByteLength(extHeader, 4);
                                            
                                            console.assert(this._length >= 0 && this._freeBytes >= 0 && this._freeBytes < this._length, 'invalid data');

                                            if (keepLock === true) {
                                                return lock;
                                            }
                                            else {
                                                return lock.release();
                                            }
                                        });
                                    });
                                },
                                loadFromExtData(allExtData) {
                                    let index = extDataOffset;
                                    this._headerLoaded = true;
                                    this._length = _readByteLength(allExtData, index);
                                    this._freeBytes = _readByteLength(allExtData, index + 4);
                                    index += this._headerLength; // 8
                                    this._values = [];
                                    for(let i = 0; i < valuesLength; i++) {
                                        const result = readEntryValue(allExtData, index);
                                        index += result.byteLength;
                                        this._values.push(result.entryValue);
                                    }
                                    this.totalValues = valuesLength;
                                },
                                addValue(recordPointer, metadata) {
                                    // add value to it. 

                                    return this.loadHeader(true)
                                    .then(lock => {
                                        // We have to add it to ext_data, and update leaf's value_list_length
                                        // no checking for existing recordPointer
                                        const builder = new BinaryBPlusTreeBuilder({ metadataKeys: tree.info.metadataKeys });
                                        const extValueData = builder.getLeafEntryValueBytes(recordPointer, metadata);
                                        if (extValueData.length > this._freeBytes) {
                                            // TODO: check if parent ext_data block has free space, maybe we can use that space
                                            lock.release();
                                            throw new DetailedError('max-extdata-size-reached', `No space left to add value to leaf ext_data_block`);
                                        }
                                        const extBlockHeader = [];
                                        // update ext_data_length:
                                        _writeByteLength(extBlockHeader, 0, this._length);
                                        // update ext_data_free_length:
                                        const newFreeBytes = this._freeBytes - extValueData.length;
                                        _writeByteLength(extBlockHeader, 4, newFreeBytes);
                                        
                                        const valueListLengthData = _writeByteLength([], 0, this.totalValues + 1);

                                        return Promise.all([
                                            // write value:
                                            tree._writeFn(extValueData, this.index + this._headerLength + this._length - this._freeBytes),
                                            // update ext_block_length, ext_block_free_length
                                            tree._writeFn(extBlockHeader, this.index),
                                            // update value_list_length
                                            tree._writeFn(valueListLengthData, this._listLengthIndex)
                                        ])
                                        .catch(err => {
                                            lock.release();
                                            throw err;
                                        })
                                        .then(() => {
                                            this._freeBytes -= extValueData.length;
                                            this.totalValues++;
                                            lock.release();

                                            // // TEST
                                            // return this.loadValues()
                                            // .catch(err => {
                                            //     console.error(`Values are kaputt for entry '${entry.key}': ${err.message}`);
                                            // })
                                            // .then(() => {
                                            //     console.log(`Values for entry '${entry.key}' successfully updated: ${this.totalValues} values`);
                                            // });

                                        })
                                    });
                                },
                                removeValue(recordPointer) {
                                    // remove value
                                    // load the whole value, then rewrite it
                                    return this.loadValues()
                                    .then(values => {
                                        // LOCK?

                                        let index = values.findIndex(val => _compareBinary(val.recordPointer, recordPointer));
                                        if (!~index) { return; }
                                        values.splice(index, 1);

                                        // rebuild ext_data_block
                                        const bytes = [
                                            0, 0, 0, 0, // ext_block_length
                                            0, 0, 0, 0  // ext_block_free_length
                                        ];

                                        // ext_block_length:
                                        _writeByteLength(bytes, 0, this._length);

                                        // Add all values
                                        const builder = new BinaryBPlusTreeBuilder({ metadataKeys: tree.info.metadataKeys });
                                        values.forEach(val => {
                                            const valData = builder.getLeafEntryValueBytes(val.recordPointer, val.metadata);
                                            _appendToArray(bytes, valData);
                                        });

                                        // update ext_block_free_length:
                                        _writeByteLength(bytes, 4, this._length - bytes.length);

                                        const valueListLengthData = _writeByteLength([], 0, this.totalValues - 1);
                                        return Promise.all([
                                            // write ext_data_block
                                            tree._writeFn(bytes, this.index),
                                            // update value_list_length
                                            tree._writeFn(valueListLengthData, this._listLengthIndex)
                                        ])
                                        .then(() => {
                                            this.totalValues--;
                                            this._freeBytes = this._length - bytes.length;
                                        });
                                    })
                                }
                            }
                        },
                        loadValues() {
                            return ThreadSafe.lock(leaf)
                            .then(l => {
                                lock = l;
                                return reader.go(extDataBlockIndex);
                            })
                            .then(() => {
                                return reader.get(8); // ext_data_length, ext_free_byte_length
                            })
                            .then(extHeader => {
                                const length = _readByteLength(extHeader, 0);
                                const freeBytes = _readByteLength(extHeader, 4);
                                return reader.get(length - freeBytes);
                            })
                            .then(data => {
                                entry._values = [];
                                let index = 0;
                                for(let i = 0; i < this.totalValues; i++) {
                                    const result = readEntryValue(data, index);
                                    index += result.byteLength;
                                    entry._values.push(entryValue.entryValue);
                                }
                                return entry._values;
                            })
                            .then(values => {
                                lock.release();
                                return values;
                            });
                        }
                    });
                    leaf.entries.push(entry);
                }
                else {
                    const entryValues = [];
                    for(let j = 0; j < valuesLength; j++) {
                        const entryValue = readValue();
                        entryValues.push(entryValue);
                    }
                    leaf.entries.push(new BinaryBPlusTreeLeafEntry(key, entryValues));
                }
            }
        }

        if (prevLeafOffset !== 0) {
            leaf.getPrevious = () => {
                const freshReader = reader.clone();
                return freshReader.go(leaf.prevLeafIndex)
                .then(() => {
                    return this._readChild(freshReader);
                })
                .then(childInfo => {
                    console.assert(childInfo.isLeaf, `previous leaf is *not* a leaf. Current leaf index: ${leaf.sourceIndex}, next leaf offset: ${prevLeafOffset}, target index: ${leaf.dataIndex + prevLeafOffset}`);
                    return this._getLeaf(childInfo, freshReader, options);
                })
                .then(leaf => {
                    return leaf;
                });
            };
        }
        if (nextLeafOffset !== 0) {
            leaf.getNext = () => {               
                const freshReader = reader.clone();
                return freshReader.go(leaf.nextLeafIndex)
                .then(() => {
                    return this._readChild(freshReader);
                })
                .then(childInfo => {
                    console.assert(childInfo.isLeaf, `next leaf is *not* a leaf. Current leaf index: ${leaf.sourceIndex}, next leaf offset: ${nextLeafOffset}, target index: ${leaf.dataIndex + 4 + nextLeafOffset}`);
                    return this._getLeaf(childInfo, freshReader, options);
                })
                .then(nextLeaf => {
                    console.assert(nextLeaf.entries.length === 0 || leaf.entries.length === 0 || _isMore(nextLeaf.entries[0].key, leaf.entries[leaf.entries.length-1].key), 'next leaf has lower keys than previous leaf?!');
                    return nextLeaf;
                });
            };
        }

        console.assert(leaf.entries.every((entry, index, arr) => index === 0 || _isMore(entry.key, arr[index-1].key)), 'Invalid B+Tree: leaf entries are not sorted ok');

        return leaf;
    }

    /**
     * 
     * @param {BinaryBPlusTreeNode} nodeInfo 
     * @returns {Promise<void>}
     */
    _writeNode(nodeInfo) {

        // Rewrite the node. 
        // NOTE: not using BPlusTreeNode.toBinary for this, because 
        // that function writes children too, we don't want that

        console.assert(nodeInfo.entries.length > 0, `node has no entries!`);
        console.assert(nodeInfo.entries.every((entry, index, arr) => index === 0 || _isMore(entry.key, arr[index-1].key)), 'Node entries are not sorted ok');

        return Promise.try(() => {
            const builder = new BinaryBPlusTreeBuilder({ 
                uniqueKeys: this.info.isUnique, 
                maxEntriesPerNode: this.info.entriesPerNode, 
                metadataKeys: this.info.metadataKeys, 
                // Not needed:
                byteLength: this.info.byteLength, 
                freeBytes: this.info.freeSpace 
            });
            const bytes = builder.createNode({
                index: nodeInfo.index,
                entries: nodeInfo.entries.map(entry => ({ key: entry.key, ltIndex: entry.ltChildIndex })),
                gtIndex: nodeInfo.gtChildIndex
            }, {
                addFreeSpace: true,
                maxLength: nodeInfo.length
            });
            console.assert(bytes.length <= nodeInfo.length, 'too many bytes allocated for node');
            
            return this._writeFn(bytes, nodeInfo.index);
        })
        .catch(err => {
            throw new DetailedError('write-node-fail', `Failed to write node: ${err.message}`, err);
        });
    }   

    /**
     * 
     * @param {BinaryBPlusTreeLeaf} leafInfo 
     * @returns {Promise<void>}
     */
    _writeLeaf(leafInfo) {
        console.assert(leafInfo.entries.every((entry, index, arr) => index === 0 || _isMore(entry.key, arr[index-1].key)), 'Leaf entries are not sorted ok');

        return Promise.try(() => {
            const builder = new BinaryBPlusTreeBuilder({ 
                uniqueKeys: this.info.isUnique, 
                maxEntriesPerNode: this.info.entriesPerNode, 
                metadataKeys: this.info.metadataKeys,
                smallLeafs: this.info.hasSmallLeafs,
                // Not needed:
                byteLength: this.info.byteLength, 
                freeBytes: this.info.freeSpace,
                fillFactor: this.info.fillFactor 
            });
            const extData = leafInfo.extData 
                ? { 
                    length: leafInfo.extData.length, 
                    freeBytes: leafInfo.extData.freeBytes, 
                    rebuild: leafInfo.extData.loaded 
                } 
                : null;
            const addFreeSpace = true;
            const writes = [];
            const bytes = builder.createLeaf({
                index: leafInfo.index,
                prevIndex: leafInfo.prevLeafIndex,
                nextIndex: leafInfo.nextLeafIndex,
                entries: leafInfo.entries,
                extData
            }, {
                addFreeSpace,
                maxLength: leafInfo.length,
                addExtData: (pointerIndex, data) => {
                    // Write additional ext_data_block
                    let extIndex = extData.length - extData.freeBytes;
                    let fileIndex = leafInfo.sourceIndex + leafInfo.length + extIndex;
                    const bytes = new Uint8ArrayBuilder();
                    const minRequired = data.length + 8;
                    if (extData.freeBytes < minRequired) {
                        throw new DetailedError('max-extdata-size-reached', 'Not enough free space in ext_data');
                    }

                    // Calculate free space
                    const maxFree = extData.freeBytes - minRequired; // Max available free space for new block
                    const free = addFreeSpace ? Math.min(maxFree, Math.ceil(data.length * 0.1)) : 0;
                    const length = data.length + free;

                    // ext_data_length:
                    bytes.writeUint32(length); //_writeByteLength(bytes, bytes.length, length);

                    // ext_data_free_length:
                    bytes.writeUint32(free); //_writeByteLength(bytes, bytes.length, free);

                    // data:
                    bytes.append(data); //_appendToArray(bytes, data);

                    // Add free space:
                    bytes.append(new Uint8Array(free)); //for (let i = 0; i < free; i++) { bytes.push(0); }

                    // Adjust extData
                    extData.freeBytes -= bytes.length;

                    let writePromise = this._writeFn(bytes.data, fileIndex)
                    .then(result => {
                        return result;
                    });
                    writes.push(writePromise);
                    return { extIndex };
                }
            });
            const maxLength = leafInfo.length + (leafInfo.extData && leafInfo.extData.loaded ? leafInfo.extData.length : 0);
            console.assert(bytes.length <= maxLength, 'more bytes needed than allocated for leaf');

            const promise = this._writeFn(bytes, leafInfo.index);
            writes.push(promise);
            
            return Promise.all(writes);
        })
        .catch(err => {
            throw new DetailedError('write-leaf-fail', `Failed to write leaf: ${err.message}`, err);
        });
    }

    /**
     * 
     * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
     * @param {ChunkReader} reader 
     * @returns {BinaryBPlusTreeNode}
     */
    _getNode(nodeInfo, reader) {
        // const node = { 
        //     entries: [] 
        // };
        
        const node = new BinaryBPlusTreeNode(nodeInfo);
        const bytes = node.bytes;
        const entriesLength = bytes[0];
        console.assert(entriesLength > 0, 'Node read failure: no entries');
        let index = 1;

        for (let i = 0; i < entriesLength; i++) {
            let keyInfo = BPlusTree.getKeyFromBinary(bytes, index);
            let key = keyInfo.key;
            index += keyInfo.byteLength;
            let entry = new BinaryBPlusTreeNodeEntry(key);
            node.entries.push(entry);

            // read lt_child_ptr:
            entry.ltChildOffset = _readSignedOffset(bytes, index, this.info.hasLargePtrs); // lt_child_ptr
            console.assert(entry.ltChildOffset !== 0, 'Node read failure: invalid ltChildOffset 0');
            entry.ltChildIndex = node.index + index + 9 + entry.ltChildOffset + (this.info.hasLargePtrs ? 5 : 3); // index + 9 header bytes, +5 because offset is from first byte
            entry.getLtChild = () => {
                // return savedPosition.go(entry.ltChildOffset)
                return reader.go(entry.ltChildIndex)
                .then(() => {
                    return this._readChild(reader);
                })
                .then(childNodeInfo => {
                    childNodeInfo.parentNode = node;
                    childNodeInfo.parentEntry = entry;
                    return childNodeInfo;
                });
            };
            index += this.info.hasLargePtrs ? 6 : 4;
        }
        // read gt_child_ptr:
        node.gtChildOffset = _readSignedOffset(bytes, index, this.info.hasLargePtrs); // gt_child_ptr
        console.assert(node.gtChildOffset !== 0, 'Node read failure: invalid gtChildOffset 0');
        node.gtChildIndex = node.index + index + 9 + node.gtChildOffset + (this.info.hasLargePtrs ? 5 : 3);  // index + 9 header bytes, +5 because offset is from first byte
        node.getGtChild = () => {
            return reader.go(node.gtChildIndex)
            .then(() => {
                return this._readChild(reader);
            })
            .then(childNodeInfo => {
                childNodeInfo.parentNode = node;
                childNodeInfo.parentEntry = null;
                return childNodeInfo;
            });
        };

        return node;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.stats] 
     * @returns {Promise<BinaryBPlusTreeLeaf>}
     */
    getFirstLeaf(options) {
        let reader;
        /**
         * 
         * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
         */
        const processChild = (nodeInfo) => {
            if (nodeInfo.isLeaf) {
                return this._getLeaf(nodeInfo, reader, options);
            }
            else {
                const node = this._getNode(nodeInfo, reader);
                const firstEntry = node.entries[0];
                console.assert(firstEntry, 'node has no entries!');
                return firstEntry.getLtChild()
                .then(processChild);
            }
        };
        return this._getReader()
        .then(r => {
            reader = r;
            return this._readChild(reader);
        })
        .then(processChild);
    }

    /**
     * 
     * @param {object} [options]
     * @param {boolean} [options.stats] 
     * @returns {Promise<BinaryBPlusTreeLeaf>}
     */
    getLastLeaf(options) {
        let reader;
        /**
         * 
         * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
         */
        const processChild = (nodeInfo) => {
            if (nodeInfo.isLeaf) {
                return this._getLeaf(nodeInfo, reader, options);
            }
            else {
                const node = this._getNode(nodeInfo, reader)
                return node.getGtChild()
                .then(processChild);
            }
        };
        return this._getReader()
        .then(r => {
            reader = r;
            return this._readChild(reader);
        })
        .then(processChild);
    }

    /**
     * 
     * @param {string|boolean|number|Date} searchKey 
     * @param {object} [options]
     * @param {boolean} [options.stats] 
     * @returns {Promise<BinaryBPlusTreeLeaf>}
     */
    findLeaf(searchKey, options) {
        // searchKey = _normalizeKey(searchKey); // if (_isIntString(searchKey)) { searchKey = parseInt(searchKey); }
        let reader;
        /**
         * 
         * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
         */
        const processChild = (nodeInfo) => {
            if (nodeInfo.isLeaf) {
                return this._getLeaf(nodeInfo, reader, options);
            }
            else {
                const node = this._getNode(nodeInfo, reader);

                // console.assert(node.entries.length > 0, `read node has no entries!`);
                if (node.entries.length === 0) { throw new Error(`read node has no entries!`); }

                const targetEntry = node.entries.find(entry => _isLess(searchKey, entry.key));
                const p = targetEntry 
                    ? targetEntry.getLtChild()
                    : node.getGtChild();
                return p.then(processChild);
            }
        };
        return this._getReader()
        .then(r => {
            reader = r;
            return this._readChild(reader);
        })
        .then(processChild);
    }

    /**
     * Searches the tree
     * @param {string|BlacklistingSearchOperator} op operator to use for key comparison, can be single value operators "<", "<=", "==", "!=", ">", ">=", "matches", "!matches", double value operators "between", "!between", and multiple value operators "in", "!in"
     * @param {string|number|boolean|Date|Array} param single value or array for double/multiple value operators
     * @param {object} [include]
     * @param {boolean} [include.keys=false]
     * @param {boolean} [include.entries=true]
     * @param {boolean} [include.values=false]
     * @param {boolean} [include.count=false]
     * @param {BinaryBPlusTreeLeafEntry[]} [include.filter=undefined] recordPointers to filter upon
     * @returns {Promise<{ entries?: BinaryBPlusTreeLeafEntry[], keys?: Array, count?: number }}
     * // {Promise<BinaryBPlusTreeLeafEntry[]>}
     */
    search(op, param, include = { entries: true, values: false, keys: false, count: false, filter: undefined }) {
        if (["in","!in","between","!between"].indexOf(op) >= 0) {
            // param must be an array
            console.assert(param instanceof Array, `param must be an array when using operator ${op}`);
        }
        if (op === "exists" || op === "!exists") {
            op = op === "exists" ? "!=" : "==";
            param = undefined;
        }
        if (param === null) { param = undefined; }

        const getLeafOptions = { stats: !(include.entries || include.values) };
        const results = {
            /** @type {BinaryBPlusTreeLeafEntry[]} */
            entries: [],
            keys: [],
            keyCount: 0,
            valueCount: 0,
            values: [] // was not implemented? is include.values used anywhere?
        };

        /** @type {BPlusTree} */
        let blacklistRpTree;
        if (op instanceof BlacklistingSearchOperator) {
            blacklistRpTree = new BPlusTree(255, true);
        }

        // const binaryCompare = (a, b) => {
        //     if (a.length < b.length) { return -1; }
        //     if (a.length > b.length) { return 1; }
        //     for (let i = 0; i < a.length; i++) {
        //         if (a[i] < b[i]) { return -1; }
        //         if (a[i] > b[i]) { return 1; }
        //     }
        //     return 0;
        // }
        const filterRecordPointers = include.filter 
            // Using string comparison:
            ? include.filter.reduce((arr, entry) => {
                arr = arr.concat(entry.values.map(val => String.fromCharCode(...val.recordPointer)));
                return arr; 
            }, [])
            // // Using binary comparison:
            // ? include.filter.reduce((arr, entry) => {
            //     arr = arr.concat(entry.values.map(val => val.recordPointer));
            //     return arr; 
            // }, []).sort(binaryCompare)
            : null;

        let totalMatches = 0;
        let totalAdded = 0;
        const valuePromises = [];
        const emptyValue = [];
        
        /**
         * @param {BinaryBPlusTreeLeafEntry} entry 
         */
        const add = (entry) => {
            totalMatches += entry.totalValues;
            const requireValues = filterRecordPointers || include.entries || include.values || op instanceof BlacklistingSearchOperator;
            if (requireValues && typeof entry.extData === 'object' && !entry.extData.loaded) {
                // We haven't got its values yet
                const p = entry.extData.loadValues()
                .then(() => {
                    return add(entry); // Do it now
                });
                valuePromises.push(p);
                return p;
            }
            if (op instanceof BlacklistingSearchOperator) {
                // Generate rp's for each value
                entry.values.forEach(val => {
                    val.rp = String.fromCharCode(...val.recordPointer);
                });

                // Check which values were previously blacklisted
                entry.values = entry.values.filter(val => {
                    return blacklistRpTree.find(val.rp) === null;
                })
                if (entry.values.length === 0) { return; }

                // Check which values should be blacklisted
                let blacklistValues = op.check(entry);
                if (blacklistValues instanceof Array) {
                    // Add to blacklist tree
                    blacklistValues.forEach(val => {
                        blacklistRpTree.add(val.rp, emptyValue);
                    });

                    // Remove from current results
                    entry.values = blacklistValues === entry.values
                        ? [] // Same array, so all values were blacklisted
                        : entry.values.filter(value => blacklistValues.indexOf(value) < 0);

                    let removed = { values: 0, entries: 0 };
                    if (include.values) {
                        // Remove from previous results (values)
                        for (let i = 0; i < results.values.length; i++) {
                            const val = results.values[i];
                            // if (!val.rp) { val.rp = String.fromCharCode(...val.recordPointer); }
                            if (blacklistRpTree.find(val.rp)) {
                                results.values.splice(i, 1);
                                i--;
                                removed.values++;
                            }
                        }
                    }
                    if (include.entries) {
                        // Remove from previous results (entries, keys)
                        for (let i = 0; i < results.entries.length; i++) {
                            const entry = results.entries[i];
                            for (let j = 0; j < entry.values.length; j++) {
                                const val = entry.values[j];
                                // if (!val.rp) { val.rp = String.fromCharCode(...val.recordPointer); }
                                if (blacklistRpTree.find(val.rp)) {
                                    entry.values.splice(j, 1);
                                    j--;
                                    if (!include.values) { removed.values++; }
                                    if (entry.values.length === 0) {
                                        results.entries.splice(i, 1);
                                        i--;
                                        removed.entries++;
                                        if (include.keys) {
                                            results.keys.splice(results.keys.indexOf(entry.key), 1);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    results.valueCount -= removed.values;
                    results.keyCount -= removed.entries;

                    if (entry.values.length === 0) { return; }
                }

                // The way BlacklistingSearchOperator is currently used (including ALL values
                // in the index besides the ones that are blacklisted along the way), we only 
                // want unique "non-blacklisted" recordpointers in the results. So, we want to 
                // remove all values that are already present in the current results:
                for (let i = 0; i < entry.values.length; i++) {
                    const currentValue = entry.values[i];
                    let remove = false;
                    if (include.values) {
                        const index = results.values.findIndex(val => val.rp === currentValue.rp);
                        remove = index >= 0;
                    }
                    else if (include.entries) {
                        // Check result entries
                        for (let j = 0; j < results.entries.length; j++) {
                            const entry = results.entries[j];
                            const index = entry.values.findIndex(val => val.rp === currentValue.rp);
                            remove = index >= 0;
                            if (remove) { break; }
                        }
                    }
                    if (remove) {
                        entry.values.splice(i, 1);
                        i--;
                    }
                }
                if (entry.values.length === 0) { return; }
            }
            if (filterRecordPointers) {
                // Apply filter first, only use what remains

                // String comparison method seem to have slightly better performance than binary

                // Using string comparison:
                const recordPointers = entry.values.map(val => String.fromCharCode(...val.recordPointer));
                const values = [];
                for (let i = 0; i < recordPointers.length; i++) {
                    let a = recordPointers[i];
                    if (~filterRecordPointers.indexOf(a)) {
                        values.push(entry.values[i]);
                    }
                }

                // // Using binary comparison:
                // const recordPointers = entry.values.map(val => val.recordPointer).sort(binaryCompare);
                // const values = [];
                // for (let i = 0; i < recordPointers.length; i++) {
                //     let a = recordPointers[i];
                //     for (let j = 0; j < filterRecordPointers.length; j++) {
                //         let b = filterRecordPointers[j];
                //         let diff = binaryCompare(a, b);
                //         if (diff === 0) {
                //             let index = entry.values.findIndex(val => val.recordPointer === a);
                //             values.push(entry.values[index]);
                //             break;
                //         }
                //         else if (diff === -1) {
                //             // stop searching for this recordpointer
                //             break;
                //         }
                //     }
                // }
                
                if (values.length === 0) { return; }
                entry.values = values;
                entry.totalValues = values.length;
            }
            if (include.entries) {
                results.entries.push(entry);
            }
            if (include.keys) {
                results.keys.push(entry.key);
            }
            if (include.values) {
                entry.values.forEach(val => results.values.push(val));
            }
            if (include.count) {
                results.keyCount++;
                results.valueCount += entry.totalValues;
            }
            totalAdded += entry.totalValues;
        };

        // const t1 = Date.now();
        // const ret = () => {
        //     const t2 = Date.now();
        //     console.log(`tree.search [${op} ${param}] took ${t2-t1}ms, matched ${totalMatches} values, returning ${totalAdded} values in ${results.entries.length} entries`);
        //     return results;
        // };
        const ret = () => {
            if (valuePromises.length > 0) {
                return Promise.all(valuePromises)
                .then(() => results)
            }
            else {
                return results;
            }
        }

        if (op instanceof BlacklistingSearchOperator) {
            // NEW: custom callback methods to check match
            // Full index scan needed
            const processLeaf = leaf => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    // const keyMatch = typeof op.keyCheck === 'function' ? op.keyCheck(entry.key) : true;
                    // if (!keyMatch) { continue; }
                    add(entry); // check will be done by add
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); // results; //ret(results);
                }
            };
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }
        else if (["<","<="].indexOf(op) >= 0) {
            const processLeaf = (leaf) => {
                let stop = false;
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (op === "<=" && _isLessOrEqual(entry.key, param)) { add(entry); }
                    else if (op === "<" && _isLess(entry.key, param)) { add(entry); }
                    else { stop = true; break; }
                }
                if (!stop && leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf)
                }
                else {
                    return ret(); //results; //ret(results);
                }
            }
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }
        else if ([">",">="].indexOf(op) >= 0) {
            const processLeaf = (leaf) => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (op === ">=" && _isMoreOrEqual(entry.key, param)) { add(entry); }
                    else if (op === ">" && _isMore(entry.key, param)) { add(entry); }
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); //results; //ret(results);
                }
            }
            return this.findLeaf(param, getLeafOptions)
            .then(processLeaf);
        }
        else if (op === "==") {
            return this.findLeaf(param, getLeafOptions)
            .then(leaf => {
                let entry = leaf.entries.find(entry => _isEqual(entry.key, param)); //entry.key === param
                if (entry) {
                    add(entry);
                }
                return ret(); // results; //ret(results);
            });
        }
        else if (op === "!=") {
            // Full index scan needed
            const processLeaf = leaf => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (_isNotEqual(entry.key, param)) { add(entry); } //entry.key !== param
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); // results; //ret(results);
                }
            };
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }
        else if (op === "like") {
            const wildcardIndex = ~(~param.indexOf('*') || ~param.indexOf('?'));
            const startSearch = wildcardIndex > 0 ? param.slice(0, wildcardIndex) : '';
            const pattern = '^' + param.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
            const re = new RegExp(pattern, 'i');
            const processLeaf = leaf => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (re.test(entry.key)) { 
                        add(entry); 
                    }
                }
                let stop = false;
                if (wildcardIndex > 0 && leaf.entries.length > 0) {
                    // Check if we can stop. If the last entry does not start with the first part of the string.
                    // Eg: like 'Al*', we can stop if the last entry starts with 'Am'
                    const lastEntry = leaf.entries[leaf.entries.length-1];
                    stop = lastEntry.key.slice(0, wildcardIndex) > startSearch;
                }
                if (!stop && leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret();
                }
            };
            if (wildcardIndex === 0) {
                return this.getFirstLeaf(getLeafOptions)
                .then(processLeaf);
            }
            else {
                return this.findLeaf(startSearch, getLeafOptions)
                .then(processLeaf);
            }
        }
        else if (op === "!like") {
            // Full index scan needed
            const pattern = '^' + param.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
            const re = new RegExp(pattern, 'i');
            const processLeaf = leaf => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (!re.test(entry.key)) { add(entry); }
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); // results; //ret(results);
                }
            };
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }        
        else if (op === "in") {
            let sorted = param.slice().sort();
            let searchKey = sorted.shift();
            const processLeaf = (leaf) => {
                while (true) {
                    let entry = leaf.entries.find(entry => _isEqual(entry.key, searchKey)); //entry.key === searchKey
                    if (entry) { add(entry); }
                    searchKey = sorted.shift();
                    if (!searchKey) {
                        return ret(); // results; //ret(results);
                    }
                    else if (searchKey > leaf.entries[leaf.entries.length-1].key) {
                        return this.findLeaf(searchKey).then(processLeaf);
                    }
                    // Stay in the loop trying more keys on the same leaf
                }
            };
            return this.findLeaf(searchKey, getLeafOptions)
            .then(processLeaf);
        }
        else if (op === "!in") {
            // Full index scan needed
            let keys = param;
            const processLeaf = (leaf) => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    if (keys.findIndex(key => _isEqual(key, entry.key)) < 0) { add(entry); } //if (keys.indexOf(entry.key) < 0)
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); //results; //ret(results);
                }
            };
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }        
        else if (op === "between") {
            let bottom = param[0], top = param[1];
            if (top < bottom) {
                let swap = top;
                top = bottom;
                bottom = swap;
            }
            return this.findLeaf(bottom)
            .then(leaf => {
                let stop = false;
                const processLeaf = leaf => {
                    for (let i = 0; i < leaf.entries.length; i++) {
                        const entry = leaf.entries[i];
                        if (_isMoreOrEqual(entry.key, bottom) && _isLessOrEqual(entry.key, top)) { add(entry); }
                        if (_isMore(entry.key, top)) { stop = true; break; }
                    }
                    if (stop || !leaf.getNext) {
                        return ret(); // results; //ret(results);
                    }
                    else {
                        return leaf.getNext().then(processLeaf);
                    }
                };
                return processLeaf(leaf, getLeafOptions);
            });
        }
        else if (op === "!between") {
            // Equal to key < bottom || key > top
            let bottom = param[0], top = param[1];
            if (top < bottom) {
                let swap = top;
                top = bottom;
                bottom = swap;
            }
            // Add lower range first, lowest value < val < bottom
            return this.getFirstLeaf(getLeafOptions)
            .then(leaf => {
                let stop = false;
                const processLeaf = leaf => {
                    for (let i = 0; i < leaf.entries.length; i++) {
                        const entry = leaf.entries[i];
                        if (_isLess(entry.key, bottom)) { add(entry); }
                        else { stop = true; break; }
                    }
                    if (!stop && leaf.getNext) {
                        return leaf.getNext().then(processLeaf);
                    }
                };
                return processLeaf(leaf);
            })
            .then(() => {
                // Now add upper range, top < val < highest value
                return this.findLeaf(top, getLeafOptions);
            })
            .then(leaf => {
                const processLeaf = leaf => {
                    for (let i = 0; i < leaf.entries.length; i++) {
                        const entry = leaf.entries[i];
                        if (_isMore(entry.key, top)) { add(entry); }
                    }
                    if (!leaf.getNext) {
                        return ret(); // results; //ret(results);
                    }
                    else {
                        return leaf.getNext().then(processLeaf);
                    }                
                };
                return processLeaf(leaf);
            });
        }
        else if (op === "matches" || op === "!matches") {
            // Full index scan needed
            let re = param;
            const processLeaf = (leaf) => {
                for (let i = 0; i < leaf.entries.length; i++) {
                    const entry = leaf.entries[i];
                    const isMatch = re.test(entry.key);
                    if ((isMatch && op === "matches") || (!isMatch && op === "!matches")) {
                        add(entry); 
                    }
                }
                if (leaf.getNext) {
                    return leaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return ret(); // results; //ret(results);
                }
            };
            return this.getFirstLeaf(getLeafOptions)
            .then(processLeaf);
        }
    }

    /**
     * 
     * @param {any} searchKey 
     * @param {object} [options]
     * @param {boolean} [options.stats] 
     * @returns {Promise<BinaryBPlusTreeLeafEntryValue>|Promise<BinaryBPlusTreeLeafEntryValue[]>|Promise<number>} returns a promise that resolves with 1 value (unique keys), a values array or the number of values (options.stats === true)
     */
    find(searchKey, options) {
        // searchKey = _normalizeKey(searchKey); //if (_isIntString(searchKey)) { searchKey = parseInt(searchKey); }
        return this.findLeaf(searchKey, options)
        .then(leaf => {
            const entry = leaf.entries.find(entry => _isEqual(searchKey, entry.key));
            if (options && options.stats) {
                return entry ? entry.totalValues : 0;
            }
            else if (entry) {
                if (entry.extData) {
                    return entry.extData.loadValues()
                    .then(() => {
                        return this.info.isUnique
                            ? entry.values[0]
                            : entry.values;
                    });
                }
                return this.info.isUnique
                    ? entry.values[0]
                    : entry.values;
            }
            else {
                return null;
            }
        });
    }

    _growTree(bytesNeeded) {
        if (!this._autoGrow) {
            return Promise.reject(new Error('Cannot grow tree - autoGrow not enabled'))
        }
        const grow = bytesNeeded - this.info.freeSpace;
        this.info.byteLength += grow;
        this.info.freeSpace += grow;
        // write
        return Promise.all([
            // byte_length:
            this._writeFn(_writeByteLength([], 0, this.info.byteLength), 0),
            // free_byte_length:
            this._writeFn(_writeByteLength([], 0, this.info.freeSpace), this.info.freeSpaceIndex)
        ]);
        
    }

    _registerFreeSpace(index, length) {
        if (!this._fst) { this._fst = []; }
        if (index + length === this.info.byteLength - this.info.freeSpace) {
            // Cancel free space allocated at the end of the file
            // console.log(`Freeing ${length} bytes from index ${index} (at end of file)`);
            this.info.freeSpace += length;
            return this._writeFn(_writeByteLength([], 0, this.info.freeSpace), this.info.freeSpaceIndex); // free_byte_length
        }
        else {
            // console.log(`Freeing ${length} bytes from index ${index} to ${index+length}`);
            this._fst.push({ index, length });
        }
    }

    _claimFreeSpace(bytesRequired) {
        // if (bytesRequired === 0) { return Promise.reject(new Error('Claiming 0 bytes')); } // ALLOW this!
        if (bytesRequired > this.info.freeSpace) { return Promise.reject(new Error('Attempt to claim more bytes than available in trailing free space')); }
        const index = this.info.byteLength - this.info.freeSpace;
        this.info.freeSpace -= bytesRequired;
        return this._writeFn(
            _writeByteLength([], 0, this.info.freeSpace), this.info.freeSpaceIndex
        );
    }

    _requestFreeSpace(bytesRequired) {
        if (bytesRequired === 0) { return Promise.reject(new Error('Requesting 0 bytes')); }
        if (!this._fst) { this._fst = []; }
        let available = this._fst.filter(block => block.length >= bytesRequired);
        if (available.length > 0) {
            let best = available.sort((a, b) => a.length < b.length ? -1 : 1)[0];
            this._fst.splice(this._fst.indexOf(best), 1);
            return Promise.resolve(best);
        }
        else {
            // Check if there is not too much wasted space
            const wastedSpace = this._fst.reduce((total, block) => total + block.length, 0);
            const maxWaste = Math.round(this._originalByteLength * 0.5); // max 50% waste
            if (wastedSpace > maxWaste) {
                throw new Error('too much space being wasted. tree rebuild is needed');
            }
            const go = () => {
                const index = this.info.byteLength - this.info.freeSpace;
                this.info.freeSpace -= bytesRequired;
                return this._writeFn(
                    _writeByteLength([], 0, this.info.freeSpace), this.info.freeSpaceIndex
                )
                .then(() => {
                    return { index, length: bytesRequired };
                });
            }
            if (this.info.freeSpace >= bytesRequired) {
                return go();
            }
            else if (this.autoGrow) {
                return this._growTree(bytesRequired)
                .then(go);
            }
            else {
                return Promise.reject(new DetailedError('tree-full-no-autogrow', `tree doesn't have ${bytesRequired} free bytes and autoGrow is not enabled`));
            }
        }
    }

    /**
     * 
     * @param {BinaryBPlusTreeLeaf} leaf 
     * @param {object} options 
     * @param {boolean} [options.growData=false]
     * @param {boolean} [options.growExtData=false]
     * @param {leaf=>any} [options.applyChanges] callback function to apply changes to leaf before writing
     * @param {boolean} [options.rollbackOnFailure=true] Whether to rewrite the original leaf on failure (only done if this is a one leaf tree) - disable if this rebuild is called because of a failure to write an updated leaf (rollback will fail too!)
     */
    _rebuildLeaf(leaf, options = { growData: false, growExtData: false, rollbackOnFailure: true, applyChanges: (leaf) => {}, prevLeaf: null, nextLeaf: null }) {
        // rebuild the leaf

        const newLeafExtDataLength = options.growExtData ? Math.ceil(leaf.extData.length * 1.1) : leaf.extData.length;
        const extDataGrowth = newLeafExtDataLength - leaf.extData.length;
        const newLeafLength = options.growData ? Math.ceil(leaf.length * 1.1) : leaf.length;
        const leafGrows = options.growData || options.growExtData;
        const bytesNeeded = newLeafLength + newLeafExtDataLength; //leafGrows ? newLeafLength + newLeafExtDataLength : 0;

        if (this.info.freeSpace < bytesNeeded && !options.growData && options.growExtData && leaf.free >= extDataGrowth) {
            // ext_data must grow but can't because there is not enough free space to create a new leaf
            // the leaf however has enough free space to shrink a bit for the ext_data
            let p = !leaf.extData.loaded 
                ? leaf.extData.load()
                : Promise.resolve();
            return p.then(() => {
                leaf.length -= extDataGrowth;
                leaf.free -= extDataGrowth;
                leaf.extData.length += extDataGrowth;
                leaf.extData.freeBytes += extDataGrowth;
                // options.growExtData = false; // already done by stealing from leaf
                // return this._rebuildLeaf(leaf, options);
                options.applyChanges && options.applyChanges(leaf);
                return this._writeLeaf(leaf);
            });
        }

        // Read additional data needed to rebuild this leaf
        const reads = [];
        if (leaf.hasExtData) {
            if (!leaf.extData.loaded) {
                // Load all ext_data
                reads.push(leaf.extData.load());
            }
            else if (!leafGrows) {
                // We're done after rewriting this leaf
                options.applyChanges && options.applyChanges(leaf);
                return this._writeLeaf(leaf);
            }
        }

        if (reads.length > 0) {
            // Try again after all additional data has been loaded
            return Promise.all(reads)
            .then(() => {
                return this._rebuildLeaf(leaf, options);
            });
        }

        const oneLeafTree = !leaf.parentNode;
        const allocPromise = oneLeafTree
            ? bytesNeeded < leaf.length + leaf.extData.length + this.info.freeSpace
                ? this._claimFreeSpace(bytesNeeded - leaf.length - leaf.extData.length)
                    .then(() => { 
                        // overwrite leaf at same index
                        return { index: leaf.index, length: bytesNeeded }; 
                    }) 
                : Promise.reject(new Error(`Not enough space to overwrite one leaf tree`)) // not possible to overwrite
            : this._requestFreeSpace(bytesNeeded); // request free space

        return allocPromise
        // .catch(err => {
        //     // Not enough space available?
        //     console.log(`Can't get ${bytesNeeded} bytes to rebuild leaf: ${err.message}`); // , leaf, options
        //     throw err;
        // })
        .then(allocated => {

            // Create new leaf
            const newLeaf = new BinaryBPlusTreeLeaf({
                isLeaf: true,
                index: allocated.index,
                length: allocated.length - newLeafExtDataLength, // Automatically gets allocated bytes, so it might grow more than requested
                hasExtData: leaf.hasExtData,
                tree: leaf.tree
            });
            newLeaf.prevLeafIndex = leaf.prevLeafIndex;
            newLeaf.nextLeafIndex = leaf.nextLeafIndex;
            newLeaf.entries = leaf.entries.map(entry => 
                new BinaryBPlusTreeLeafEntry(entry.key, entry.values.slice()));
            if (leaf.hasExtData) {
                newLeaf.extData = {
                    loaded: true,
                    length: newLeafExtDataLength,
                    freeBytes: leaf.extData.freeBytes + (newLeafExtDataLength - leaf.extData.length)
                };
            }

            // Update indexes pointing to this leaf
            if (leaf.parentEntry) {
                leaf.parentEntry.ltChildIndex = newLeaf.index;
            }
            else if (leaf.parentNode) {
                leaf.parentNode.gtChildIndex = newLeaf.index;
            }

            const freedBytes = leaf.length + leaf.extData.length;

            // console.log(`Rebuilding leaf for entries "${leaf.entries[0].key}" to "${leaf.entries[leaf.entries.length-1].key}"`);
            options.applyChanges && options.applyChanges(newLeaf);

            // Start transaction
            const tx = new TX();

            // Write new leaf:
            tx.queue({
                name: 'new leaf',
                action: () => {
                    return this._writeLeaf(newLeaf)
                    .then(result => {
                        // console.log(`new leaf for entries "${newLeaf.entries[0].key}" to "${newLeaf.entries.slice(-1)[0].key}" was written successfully at index ${newLeaf.index} (used to be at ${leaf.index})`);
                        return `${result.length} leaf writes`;
                    })
                    // .then(result => {
                    //     // TEST leaf
                    //     return this.findLeaf(newLeaf.entries[0].key)
                    //     .then(leaf => {
                    //         const promises = [];
                    //         leaf.entries.forEach(entry => {
                    //             if (entry.extData) {
                    //                 promises.push(entry.extData.loadValues());
                    //             }
                    //         });
                    //         return Promise.all(promises);
                    //     })
                    //     .then(() => {
                    //         return result;
                    //     })
                    // })
                    // .catch(err => {
                    //     console.error(`failed to write new leaf: ${err.message}`);
                    //     throw err;
                    // });
                },
                rollback: () => {
                    // release allocated space again
                    if (oneLeafTree) {
                        if (options.rollbackOnFailure === false) {
                            return Promise.resolve();
                        }
                        return this._writeLeaf(leaf);
                    }
                    else {
                        return this._registerFreeSpace(allocated.index, allocated.length);
                    }
                }
            });

            // Adjust previous leaf's next_leaf_ptr:
            if (leaf.getPrevious) {
                const prevLeaf = {
                    nextPointerIndex: leaf.prevLeafIndex + BinaryBPlusTreeLeaf.nextLeafPtrIndex,
                    oldOffset: BinaryBPlusTreeLeaf.getNextLeafOffset(leaf.prevLeafIndex, leaf.index),
                    newOffset: BinaryBPlusTreeLeaf.getNextLeafOffset(leaf.prevLeafIndex, newLeaf.index)
                };
                tx.queue({
                    name: 'prev leaf next_leaf_ptr',
                    action: () => {
                        const bytes = _writeSignedOffset([], 0, prevLeaf.newOffset, true);
                        return this._writeFn(bytes, prevLeaf.nextPointerIndex);
                    },
                    rollback: () => {
                        const bytes = _writeSignedOffset([], 0, prevLeaf.oldOffset, true);
                        return this._writeFn(bytes, prevLeaf.nextPointerIndex);
                    }
                });
            }

            // Adjust next leaf's prev_leaf_ptr:
            if (leaf.getNext) {
                const nextLeaf = {
                    prevPointerIndex: leaf.nextLeafIndex + BinaryBPlusTreeLeaf.prevLeafPtrIndex,
                    oldOffset: BinaryBPlusTreeLeaf.getPrevLeafOffset(leaf.nextLeafIndex, leaf.index),
                    newOffset: BinaryBPlusTreeLeaf.getPrevLeafOffset(leaf.nextLeafIndex, newLeaf.index)
                };
                tx.queue({
                    name: 'next leaf prev_leaf_ptr',
                    action: () => {
                        const bytes = _writeSignedOffset([], 0, nextLeaf.newOffset, true);
                        return this._writeFn(bytes, nextLeaf.prevPointerIndex);
                    },
                    rollback: () => {
                        const bytes = _writeSignedOffset([], 0, nextLeaf.oldOffset, true);
                        return this._writeFn(bytes, nextLeaf.prevPointerIndex);
                    }
                });
            }

            // Rewrite parent node
            if (leaf.parentNode) {
                tx.queue({
                    name: 'parent node',
                    action: () => {
                        return this._writeNode(leaf.parentNode);
                    },
                    rollback: () => {
                        // Set the target leaf indexes back to the originals
                        if (leaf.parentEntry) {
                            leaf.parentEntry.ltChildIndex = leaf.index;
                        }
                        else {
                            leaf.parentNode.gtChildIndex = leaf.index;
                        }
                        if (options.nextLeaf.parentNode === leaf.parentNode) {
                            if (options.nextLeaf.parentEntry) {
                                options.nextLeaf.parentEntry.ltChildIndex = options.nextLeaf.index;
                            }
                            else {
                                options.nextLeaf.parentNode.gtChildIndex = options.nextLeaf.index;
                            }
                        }
                        return this._writeNode(leaf.parentNode);
                    }
                });
            }

            return tx.execute(true)
            .then(results => {
                if (!oneLeafTree) {
                    return this._registerFreeSpace(leaf.index, freedBytes);
                }
            });          
        })
        // .then(async results => {
        //     await this._testTree();
        //     return results;
        // })
        .catch(err => {
            throw new DetailedError('rebuild-leaf-failed', `Failed to rebuild leaf: ${err.message}`, err);
        });
    }

    /**
     * 
     * @param {BinaryBPlusTreeNode} node 
     * @param {object} options 
     * @returns {Promise<{ node1: BinaryBPlusTreeNode, node2: BinaryBPlusTreeNode }>}
     */
    _splitNode(node, options = { maxEntries: 0, cancelCallback: null }) {
        // split node if it could not be written.
        // There needs to be enough free space to store another leaf the size of current node,
        // and the parent node must not be full.

        if (typeof options.cancelCallback !== 'function') { 
            throw new Error('specify options.cancelCallback to undo any changes when a rollback needs to be performed');
        }
        
        return Promise.try(() => {
            if (!node.parentNode) {
                throw new DetailedError('cannot-split-top-level-node', `Cannot split top-level node, tree rebuild is needed`);
            }

            if (node.parentNode.entries.length >= this.info.entriesPerNode) {
                // Split parent node, try again
                return this._splitNode(node.parentNode, { cancelCallback() {} })
                .then(({ node1, node2 }) => {
                    // find out if this node is now a child of node1 or node2, update properties and try again
                    let parentEntry = node1.entries.find(e => node1.index + e.ltChildOffset === node.index); //node1.entries.find(entry => entry === node.parentEntry); // 
                    if (parentEntry) { 
                        node.parentNode = node1; 
                        node.parentEntry = parentEntry; 
                    }
                    else if (node1.index + node1.gtChildOffset === node.index) {
                        node.parentNode = node1;
                        node.parentEntry = null;
                    }
                    else {
                        node.parentNode = node2;
                        node.parentEntry = node2.entries.find(e => node1.index + e.ltChildOffset === node.index); // null if gtChild
                                                
                        if (node.parentEntry === null && node.entries[0].key <= node2.entries[node2.entries.length-1].key) {
                            debugger;
                            throw new Error(`Node's first entry key (${node.entries[0].key}) <= node2's last entry key ${node2.entries[node2.entries.length-1].key}`);
                        }
                    }

                    // Retry
                    return this._splitNode(node, options);
                });
            }

            if (typeof options.maxEntries !== 'number' || options.maxEntries === 0) {
                options.maxEntries = Math.floor(node.entries.length / 2);
            }

            const movingEntries = node.entries.slice(-options.maxEntries);
            const newNodeLength = node.length; // Use same length as current node
    
            return this._requestFreeSpace(newNodeLength)
            .then(allocated => {
    
                // console.log(`Splitting node "${node.entries[0].key}" to "${node.entries.slice(-1)[0].key}", cutting at "${movingEntries[0].key}"`);
    
                // Create new node
                const newNode = new BinaryBPlusTreeNode({
                    isLeaf: false,
                    length: newNodeLength,
                    index: allocated.index,
                    tree: node.tree
                });
    
                // move entries
                node.entries.splice(-options.maxEntries);
                newNode.entries.push(...movingEntries);
                // console.log(`Creating new node for ${movingEntries.length} entries`);
    
                // Update parent node entry pointing to this node
                const oldParentNode = new BinaryBPlusTreeNode({
                    isLeaf: false,
                    index: node.parentNode.index,
                    length: node.parentNode.length,
                    free: node.parentNode.free
                })
                oldParentNode.gtChildIndex = node.parentNode.gtChildIndex;
                oldParentNode.entries = node.parentNode.entries.map(entry => { 
                    let newEntry = new BinaryBPlusTreeNodeEntry(entry.key);
                    newEntry.ltChildIndex = entry.ltChildIndex;
                    return newEntry;
                });
    
                if (node.parentEntry !== null) {
                    // Current node is a parent node entry's ltChild
                    // eg: current node [10,11,12, ... ,18,19] is parent node [10,20,30] second entry's (20) ltChild.
                    // When splitting to [10, ..., 14] and [15, ..., 19], we have to add key 15 to parent: [10,15,20,30]
                    const newEntryKey = node.parentEntry.key;       // (20 in above example)
                    node.parentEntry.key = movingEntries[0].key;    // (15 in above example)
                    // Add new node entry for created node
                    const insertIndex = node.parentNode.entries.indexOf(node.parentEntry)+1;
                    const newNodeEntry = new BinaryBPlusTreeNodeEntry(newEntryKey);
                    newNodeEntry.ltChildIndex = newNode.index; // Set the target index, so _writeNode knows it must calculate the target offset
                    node.parentNode.entries.splice(insertIndex, 0, newNodeEntry);
                }
                else {
                    // Current node is parent node's gtChild
                    const newNodeEntry = new BinaryBPlusTreeNodeEntry(movingEntries[0].key);
                    newNodeEntry.ltChildIndex = node.index;
                    node.parentNode.entries.push(newNodeEntry);
                    node.parentNode.gtChildIndex = newNode.index;
                }
    
                // Start transaction
                const tx = new TX();
    
                // Write new node:
                tx.queue({
                    name: 'write new node',
                    action: () => {
                        return this._writeNode(newNode);
                    },
                    rollback: () => {
                        // Release allocated space again
                        return this._registerFreeSpace(allocated.index, allocated.length);
                    }
                    // No need to add rollback step to remove new node. It'll be overwritten later
                });
    
                // Rewrite this node:
                tx.queue({
                    name: 'rewrite current node',
                    action: () => {
                        return this._writeNode(node);
                    },
                    rollback: () => {
                        node.entries.push(...movingEntries);
                        let p = options.cancelCallback();
                        if (p instanceof Promise) {
                            return p.then(() => {
                                return this._writeNode(node);
                            });
                        }
                        return this._writeNode(node);
                    }
                });
    
                // Rewrite parent node:
                tx.queue({
                    name: 'rewrite parent node',
                    action: () => {
                        return this._writeNode(node.parentNode);
                    },
                    rollback: () => {
                        // this is the last step, we don't need to rollback if we are running the tx sequentially. 
                        // Because we run parallel, we need rollback code here:
                        return this._writeNode(oldParentNode);
                    }
                });
            
                return tx.execute(true) // run parallel
                .then(() => ({ node1: node, node2: newNode }));
            });
        })
        // .then(async results => {
        //     await this._testTree();
        //     return results;
        // })
        .catch(err => {
            throw new DetailedError('split-node-failed', `Unable to split node: ${err.message}`, err);
        });    
    }

    /**
     * 
     * @param {BinaryBPlusTreeLeaf} leaf 
     * @param {object} options 
     */
    _splitLeaf(leaf, options = { nextLeaf: null, maxEntries: 0, cancelCallback: null }) {
        // split leaf if it could not be written.
        // There needs to be enough free space to store another leaf the size of current leaf

        if (typeof options.cancelCallback !== 'function') { 
            throw new Error('specify options.cancelCallback to undo any changes when a rollback needs to be performed');
        }
        
        if (leaf.parentNode.entries.length >= this.info.entriesPerNode) {
            return Promise.reject(new DetailedError('parent-node-full', `Cannot split leaf because parent node is full`));
            
            // NEW: split parent node!
            /* TODO: Thorough testing before enabling 
            return this._splitNode(leaf.parentNode, { cancelCallback() {} })
            .then(({ node1, node2 }) => {
                // find out if leaf is now a child of node1 or node2, update properties and try again
                let parentEntry = node1.entries.find(e => node1.index + e.ltChildOffset === leaf.index); //node1.entries.find(entry => entry === node.parentEntry); // 
                if (parentEntry) { 
                    leaf.parentNode = node1; 
                    leaf.parentEntry = parentEntry; 
                }
                else if (node1.index + node1.gtChildOffset === leaf.index) {
                    leaf.parentNode = node1;
                    leaf.parentEntry = null;
                }
                else {
                    leaf.parentNode = node2;
                    leaf.parentEntry = node2.entries.find(e => node1.index + e.ltChildOffset === leaf.index); // null if gtChild
                                            
                    if (leaf.parentEntry === null && leaf.entries[0].key <= node2.entries[node2.entries.length-1].key) {
                        debugger;
                        throw new Error(`Leaf's first entry key (${leaf.entries[0].key}) <= node2's last entry key ${node2.entries[node2.entries.length-1].key}`);
                    }
                }

                // Retry
                return this._splitLeaf(leaf, options);
            }); */
        }

        if (typeof options.maxEntries !== 'number' || options.maxEntries === 0) {
            options.maxEntries = Math.floor(leaf.entries.length / 2);
        }

        // Check if additional data has to be loaded before proceeding
        const reads = [];
        if (!options.nextLeaf && leaf.getNext) {
            // Load next leaf first
            reads.push(
                leaf.getNext()
                .then(nextLeaf => {
                    options.nextLeaf = nextLeaf;
                })
            );
        }
        if (leaf.hasExtData && !leaf.extData.loaded) {
            // load all ext_data before proceeding with split
            reads.push(leaf.extData.load());
        }
        if (reads.length > 0) {
            return Promise.all(reads)
            .then(() => { 
                return this._splitLeaf(leaf, options); 
            });
        }

        return Promise.try(() => {
            const movingEntries = leaf.entries.slice(-options.maxEntries);
            // const movingExtDataLength =  movingEntry.extData ? Math.ceil((movingEntry.extData.length - movingEntry.extData.freeBytes) * 1.1) : 0;
            const movingExtDataLength = Math.ceil(movingEntries.reduce((length, entry) => {
                return length + (entry.extData ? entry.extData.length + 8 - entry.extData.freeBytes : 0);
            }, 0)  / movingEntries.length * this.info.entriesPerNode);

            const newLeafExtDataLength = Math.ceil(movingExtDataLength * 1.1);
            const newLeafLength = leaf.length; // Use same length as current leaf

            return this._requestFreeSpace(newLeafLength + newLeafExtDataLength)
            .then(allocated => {

                // console.log(`Splitting leaf "${leaf.entries[0].key}" to "${leaf.entries.slice(-1)[0].key}", cutting at "${movingEntries[0].key}"`);

                const nextLeaf = options.nextLeaf;

                // Create new leaf
                const newLeaf = new BinaryBPlusTreeLeaf({
                    isLeaf: true,
                    length: newLeafLength,
                    index: allocated.index, //(this.info.byteLength - this.info.freeSpace) //+ 1,
                    tree: leaf.tree,
                    hasExtData: newLeafExtDataLength > 0
                });
                if (newLeafExtDataLength > 0) {
                    newLeaf.extData = {
                        loaded: true,
                        length: newLeafExtDataLength,
                        freeBytes: newLeafExtDataLength - movingExtDataLength
                    };
                }

                // Adjust free space length and prev & next offsets
                // this.info.freeSpace -= newLeafLength + newLeafExtDataLength;
                newLeaf.prevLeafIndex = leaf.index;
                newLeaf.nextLeafIndex = nextLeaf ? nextLeaf.index : 0;
                leaf.nextLeafIndex = newLeaf.index;
                if (nextLeaf) {
                    nextLeaf.prevLeafIndex = newLeaf.index;
                }

                // move entries
                leaf.entries.splice(-options.maxEntries);
                newLeaf.entries.push(...movingEntries);
                // console.log(`Creating new leaf for ${movingEntries.length} entries`);

                // Update parent node entry pointing to this leaf
                const oldParentNode = new BinaryBPlusTreeNode({
                    isLeaf: false,
                    index: leaf.parentNode.index,
                    length: leaf.parentNode.length,
                    free: leaf.parentNode.free
                })
                oldParentNode.gtChildIndex = leaf.parentNode.gtChildIndex;
                oldParentNode.entries = leaf.parentNode.entries.map(entry => { 
                    let newEntry = new BinaryBPlusTreeNodeEntry(entry.key);
                    newEntry.ltChildIndex = entry.ltChildIndex;
                    return newEntry;
                });

                if (leaf.parentEntry !== null) {
                    // Current leaf is a parent node entry's ltChild
                    // eg: current leaf [10,11,12, ... ,18,19] is parent node [10,20,30] second entry's (20) ltChild.
                    // When splitting to [10, ..., 14] and [15, ..., 19], we have to add key 15 to parent: [10,15,20,30]
                    const newEntryKey = leaf.parentEntry.key;       // (20 in above example)
                    leaf.parentEntry.key = movingEntries[0].key;    // (15 in above example)
                    // Add new node entry for created leaf
                    const insertIndex = leaf.parentNode.entries.indexOf(leaf.parentEntry)+1;
                    const newNodeEntry = new BinaryBPlusTreeNodeEntry(newEntryKey);
                    newNodeEntry.ltChildIndex = newLeaf.index; // Set the target index, so _writeNode knows it must calculate the target offset
                    leaf.parentNode.entries.splice(insertIndex, 0, newNodeEntry);
                }
                else {
                    // Current leaf is parent node's gtChild
                    const newNodeEntry = new BinaryBPlusTreeNodeEntry(movingEntries[0].key);
                    newNodeEntry.ltChildIndex = leaf.index;
                    leaf.parentNode.entries.push(newNodeEntry);
                    leaf.parentNode.gtChildIndex = newLeaf.index;
                }

                // Start transaction
                const tx = new TX();

                // Write new leaf:
                tx.queue({
                    name: 'write new leaf',
                    action: () => {
                        return this._writeLeaf(newLeaf);
                    },
                    rollback: () => {
                        // Release allocated space again
                        return this._registerFreeSpace(allocated.index, allocated.length);
                    }
                    // No need to add rollback step to remove new leaf. It'll be overwritten later
                });

                // Rewrite next leaf:
                nextLeaf && tx.queue({
                    name: 'rewrite next leaf',
                    action: () => {
                        return this._writeLeaf(nextLeaf);
                    },
                    rollback: () => {
                        nextLeaf.prevLeafIndex = leaf.index;
                        return this._writeLeaf(nextLeaf);                
                    }
                });

                // Rewrite this leaf:
                tx.queue({
                    name: 'rewrite current leaf',
                    action: () => {
                        return this._writeLeaf(leaf);
                    },
                    rollback: () => {
                        leaf.entries.push(...movingEntries);
                        leaf.nextLeafIndex = nextLeaf ? nextLeaf.index : 0;
                        let p = options.cancelCallback();
                        if (p instanceof Promise) {
                            return p.then(() => {
                                return this._writeLeaf(leaf);
                            });
                        }
                        return this._writeLeaf(leaf);
                    }
                });

                // Rewrite parent node:
                tx.queue({
                    name: 'rewrite parent node',
                    action: () => {
                        return this._writeNode(leaf.parentNode);
                    },
                    rollback: () => {
                        // this is the last step, we don't need to rollback if we are running the tx sequentially. 
                        // Because we run parallel, we need rollback code here:
                        return this._writeNode(oldParentNode);
                    }
                });
            
                return tx.execute(true); // run parallel
            });
        })
        // .then(async results => {
        //     await this._testTree();
        //     return results;
        // })
        .catch(err => {
            throw new DetailedError('split-leaf-failed', `Unable to split leaf: ${err.message}`, err);
        });
    }

    // async _testTree() {
    //     // Test tree by looking up all entries individually
    //     let leaf = await this.getFirstLeaf();
    //     const keys = leaf.entries.map(e => e.key);
    //     while (leaf.getNext) {
    //         leaf = await leaf.getNext();
    //         keys.push(...leaf.entries.map(e => e.key));
    //     }
    //     console.warn(`TREE TEST: testing ${keys.length} keys`);
    //     for (let i = 0; i < keys.length; i++) {
    //         const key = keys[i];
    //         leaf = await this.findLeaf(key);
    //         console.assert(leaf && leaf.entries.find(e => e.key === key), `Key "${key}" must be in leaf`);
    //     }
    //     console.warn(`TREE TEST SUCCESSFUL`);
    // }

    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer 
     * @param {object} [metadata] 
     */
    add(key, recordPointer, metadata) {
        const err = _checkNewEntryArgs(key, recordPointer, this.metadataKeys, metadata);
        if (err) {
            throw err;
        }
        const entryValue = new BinaryBPlusTreeLeafEntryValue(recordPointer, metadata);
        var lock;
        if (!this.id) {
            throw new DetailedError('tree-id-not-set', `To edit tree, set the id property to something unique for locking purposes`);
        }
        return ThreadSafe.lock(this.id, { timeout: 15 * 60 * 1000 }) // 15 minutes for debugging: 
        // return this.findLeaf(key)
        // .then(leaf => {
        //     // This is the leaf the key should be added to
        //     return ThreadSafe.lock(`leaf@${leaf.index}`, { target: leaf }); // LOCK THE LEAF for editing
        // })
        .then(l => {
            lock = l;
            return this.findLeaf(key);
        })
        .then(leaf => {
            if (!this.info.hasLargePtrs) {
                throw new DetailedError('small-ptrs-deprecated', 'small ptrs have deprecated, tree will have to be rebuilt');
            }
    
            const entryIndex = leaf.entries.findIndex(entry => _isEqual(key, entry.key));
            let addNew = false;
            if (this.info.isUnique) {
                // Make sure key doesn't exist yet
                if (~entryIndex) {
                    throw new DetailedError('unique-key-violation', `Cannot add duplicate key "${key}": tree expects unique keys`);
                }

                addNew = true;
            }
            else {
                if (~entryIndex) {
                    const entry = leaf.entries[entryIndex];
                    if (entry.extData) {
                        return entry.extData.addValue(recordPointer, metadata)
                        .catch(err => {
                            // Something went wrong adding the value. ext_data_block is probably full
                            // and needs to grow
                            console.log(`Leaf rebuild necessary - unable to add value to key "${key}": ${err.message}`);

                            const rebuildOptions = { 
                                growData: false,
                                growExtData: true,
                                applyChanges: leaf => {
                                    const entry = leaf.entries.find(entry => _isEqual(entry.key, key)); //[entryIndex];
                                    entry.values.push(new BinaryBPlusTreeLeafEntryValue(recordPointer, metadata));
                                }
                            };
                            return this._rebuildLeaf(leaf, rebuildOptions);

                            // Refactored code to be included in _rebuildLeaf:
                            // // Try assigning 10% more bytes to the ext_data_block that needs to grow
                            // // Load all ext_data so we can make changes before _rebuildLeaf executes (which will otherwise attempt to read extData from wrong index and fail)
                            // return leaf.extData.load()
                            // .then(() => {
                            //     const growBytes = Math.ceil(entry.extData.length * 0.1);
                            //     const rebuildOptions = { 
                            //         growData: false,
                            //         growExtData: true,
                            //         applyChanges: (leaf) => {
                            //             const entry = leaf.entries[entryIndex];
                            //             entry.values.push(new BinaryBPlusTreeLeafEntryValue(recordPointer, metadata));
                            //         }
                            //     };
                            //     if (leaf.free >= growBytes) {
                            //         // Steal bytes from free leaf space: we can do this because the entire leaf will be rebuilt!
                            //         leaf.length -= growBytes;
                            //         leaf.free -= growBytes;
                            //         // Grow ext_data:
                            //         leaf.extData.length += growBytes;
                            //         // Grow ext_data_block: modify the private properties, the public ones are read-only
                            //         entry.extData._length += growBytes; 
                            //         entry.extData._freeBytes += growBytes;
                            //         // Rebuild leaf without growing ext_data:
                            //         rebuildOptions.growExtData = false; // already done!
                            //     }
                            //     return this._rebuildLeaf(leaf, rebuildOptions);                                
                            // });
                        });
                    }

                    entry.values.push(entryValue);
                }
                else {
                    addNew = true;
                }
            }

            if (!addNew) {
                return this._writeLeaf(leaf)
                .catch(err => {
                    // Leaf got too small? Try rebuilding it
                    // const entry = leaf.entries[entryIndex];
                    // const hasExtData = typeof entry.extData === 'object';
                    const extDataError = err.message.match(/ext_data/) !== null;
                    return this._rebuildLeaf(leaf, {
                        growData: !extDataError, 
                        growExtData: extDataError,
                        rollbackOnFailure: false // Disable original leaf rewriting on failure
                    });
                })
                .catch(err => {
                    throw new DetailedError('add-value-failed', `Can't add value to key '${key}': ${err.message}`, err);
                });
            }

            // If we get here, we have to add a new leaf entry
            const entry = new BinaryBPlusTreeLeafEntry(key, [entryValue]);

            // Insert it
            let insertBeforeIndex = leaf.entries.findIndex(entry => _isMore(entry.key, key));
            if (insertBeforeIndex < 0) { 
                leaf.entries.push(entry);
            }
            else {
                leaf.entries.splice(insertBeforeIndex, 0, entry);    
            }
            
            if (leaf.entries.length <= this.info.entriesPerNode) {
                return this._writeLeaf(leaf)
                .catch(err => {
                    // Leaf had no space left, try rebuilding it
                    return this._rebuildLeaf(leaf, { 
                        growData: true, 
                        growExtData: true,
                        rollbackOnFailure: false // Don't try rewriting updated leaf on failure
                    });
                    // .catch(err => {
                    //     throw new DetailedError('add-key-failed', `Can't add key '${key}': ${err.message}`, err);
                    // });
                });
            }
 
            // If we get here, our leaf has too many entries

            const undoAdd = () => {
                if (insertBeforeIndex === null) {
                    return; // Already undone, prevent double action
                }
                if (insertBeforeIndex < 0) {
                    leaf.entries.pop();
                }
                else {
                    leaf.entries.splice(insertBeforeIndex, 1);
                }
                insertBeforeIndex = null;            
            };

            if (!leaf.parentNode) {
                // No parent, so this is a 1 leaf "tree"
                undoAdd();
                throw new DetailedError('slt-no-space-available', `Cannot add key "${key}", no space left in single leaf tree`);
            }

            // Split leaf
            return this._splitLeaf(leaf, { cancelCallback: undoAdd });
            // .catch(err => {
            //     throw new DetailedError('split-leaf-failed', `Can't add key '${key}': ${err.message}`, err);
            // });

        })
        .catch(err => {
            lock.release();
            throw new DetailedError('add-key-failed', `Can't add key '${key}': ${err.message}`, err);
        })
        .then(() => {
            lock.release();
        })
        // .then(() => {
        //     // TEST the tree adjustments by getting the leaf with the added key, 
        //     // and then previous and next leafs!
        //     console.warn(`TESTING leaf adjustment after adding "${key}". Remove code when all is well!`);
        //     return this.findLeaf(key);
        // })
        // .then(leaf => {
        //     let promises = leaf.entries.map(entry => {
        //         if (entry.extData) {
        //             return entry.extData.loadValues();
        //         }
        //         return null;
        //     })
        //     .filter(p => p !== null);
        //     return Promise.all(promises);
        //     // return leaf.hasExtData && leaf.extData.load();
        // });
        // .then(leaf => {
        //     let prev = leaf.getPrevious ? leaf.getPrevious() : null;
        //     let next = leaf.getNext ? leaf.getNext() : null;
        //     return Promise.all([leaf, prev, next]);
        // })
        // .then(results => {
        //     let leaf = results[0];
        //     let prev = results[1];
        //     let next = results[2];
        // });
    }

    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer 
     */
    remove(key, recordPointer = undefined) {
        // key = _normalizeKey(key); //if (_isIntString(key)) { key = parseInt(key); }
        return this.findLeaf(key)
        .then(leaf => {
            // This is the leaf the key should be in
            if (!this.info.hasLargePtrs) {
                throw new DetailedError('small-ptrs-deprecated', 'small ptrs have deprecated, tree will have to be rebuilt');
            }
            const entryIndex = leaf.entries.findIndex(entry => _isEqual(key, entry.key));
            if (!~entryIndex) { return; }
            if (this.info.isUnique || typeof recordPointer === "undefined" || leaf.entries[entryIndex].totalValues === 1) {
                leaf.entries.splice(entryIndex, 1);
            }
            else if (leaf.entries[entryIndex].extData) {
                return leaf.entries[entryIndex].extData.removeValue(recordPointer);
            }
            else {
                let valueIndex = leaf.entries[entryIndex].values.findIndex(val => _compareBinary(val.recordPointer, recordPointer));
                if (!~valueIndex) { return; }
                leaf.entries[entryIndex].values.splice(valueIndex, 1);
            }
            if (leaf.parentNode && leaf.entries.length === 0) {
                // This is not a single leaf tree, and the leaf is now empty. Remove it

                if (leaf.parentNode.entries.length === 1) {
                    // Parent node has only 1 entry, removing it would also make parent node empty...
                    throw new DetailedError('leaf-empty', 'leaf is now empty and parent node has only 1 entry, tree will have to be rebuilt');
                }

                return this._removeLeaf(leaf);
            }
            return this._writeLeaf(leaf);
        })
        .catch(err => {
            throw new DetailedError('remove-key-failed', `Can't remove key '${key}': $${err.message}`, err);
        });
    }

    /**
     * Removes an empty leaf
     * @param {BinaryBPlusTreeLeaf} leaf 
     */
    _removeLeaf(leaf) {
        return Promise.try(() => {
            console.assert(leaf.parentNode && leaf.parentNode.entries.length >= 2, `Leaf to remove must have a parent node with at least 2 entries`);
            console.assert(leaf.entries.length === 0, `Leaf to remove must be empty`);

            const freedBytes = leaf.length + leaf.extData.length;

            // Start transaction
            const tx = new TX();

            // Adjust previous leaf's next_leaf_ptr: (point it to leaf's next leaf)
            if (leaf.getPrevious) {
                const prevLeaf = {
                    nextPointerIndex: leaf.prevLeafIndex + BinaryBPlusTreeLeaf.nextLeafPtrIndex,
                    oldOffset: BinaryBPlusTreeLeaf.getNextLeafOffset(leaf.prevLeafIndex, leaf.index),
                    newOffset: BinaryBPlusTreeLeaf.getNextLeafOffset(leaf.prevLeafIndex, leaf.nextLeafIndex)
                };
                tx.queue({
                    name: 'prev leaf next_leaf_ptr',
                    action: () => {
                        const bytes = _writeSignedOffset([], 0, prevLeaf.newOffset, true);
                        return this._writeFn(bytes, prevLeaf.nextPointerIndex);
                    },
                    rollback: () => {
                        const bytes = _writeSignedOffset([], 0, prevLeaf.oldOffset, true);
                        return this._writeFn(bytes, prevLeaf.nextPointerIndex);
                    }
                });
            }

            // Adjust next leaf's prev_leaf_ptr: (point it to leaf's previous leaf)
            if (leaf.getNext) {
                const nextLeaf = {
                    prevPointerIndex: leaf.nextLeafIndex + BinaryBPlusTreeLeaf.prevLeafPtrIndex,
                    oldOffset: BinaryBPlusTreeLeaf.getPrevLeafOffset(leaf.nextLeafIndex, leaf.index),
                    newOffset: BinaryBPlusTreeLeaf.getPrevLeafOffset(leaf.nextLeafIndex, leaf.prevLeafIndex)
                };
                tx.queue({
                    name: 'next leaf prev_leaf_ptr',
                    action: () => {
                        const bytes = _writeSignedOffset([], 0, nextLeaf.newOffset, true);
                        return this._writeFn(bytes, nextLeaf.prevPointerIndex);
                    },
                    rollback: () => {
                        const bytes = _writeSignedOffset([], 0, nextLeaf.oldOffset, true);
                        return this._writeFn(bytes, nextLeaf.prevPointerIndex);
                    }
                });
            }

            // Rewrite parent node
            const parentNodeInfo = {
                entries: leaf.parentNode.entries.slice(),
                gtChildIndex: leaf.parentNode.gtChildIndex
            };
            // Remove parent node entry or change gtChildOffset
            if (leaf.parentEntry) {
                const removeEntryIndex = leaf.parentNode.entries.indexOf(leaf.parentEntry);
                leaf.parentNode.entries.splice(removeEntryIndex, 1);
            }
            else {
                // Change gtChildOffset to last entry's offset
                const lastEntry = leaf.parentNode.entries.splice(-1)[0];
                leaf.parentNode.gtChildIndex = lastEntry.ltChildIndex;
            }

            tx.queue({
                name: 'parent node',
                action: () => {
                    return this._writeNode(leaf.parentNode);
                },
                rollback: () => {
                    // Set the target leaf indexes back to the originals
                    leaf.parentNode.entries = parentNodeInfo.entries;
                    leaf.parentNode.gtChildIndex = parentNodeInfo.gtChildIndex;
                    return this._writeNode(leaf.parentNode);
                }
            });

            return tx.execute(true)
            .then(results => {
                return this._registerFreeSpace(leaf.index, freedBytes);
            });
        })
        // .then(async results => {
        //     await this._testTree();
        //     return results;
        // })
        .catch(err => {
            throw new DetailedError('remove-leaf-failed', `Failed to remove leaf: ${err.message}`, err);
        });
    }

    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} newRecordPointer 
     * @param {number[]|Uint8Array} [currentRecordPointer] 
     * @param {object} [newMetadata]
     */
    update(key, newRecordPointer, currentRecordPointer = undefined, newMetadata) {
        // key = _normalizeKey(key); // if (_isIntString(key)) { key = parseInt(key); }
        if (currentRecordPointer === null) { currentRecordPointer = undefined; }
        const newEntryValue = new BPlusTreeLeafEntryValue(newRecordPointer, newMetadata);
        return this.findLeaf(key)
        .then(leaf => {
            // This is the leaf the key should be in
            const entryIndex = leaf.entries.findIndex(entry => _isEqual(entry.key, key));
            if (!~entryIndex) { 
                throw new DetailedError('key-not-found', `Key to update ("${key}") not found`); 
            }
            const entry = leaf.entries[entryIndex];
            if (this.info.isUnique) {
                entry.values = [newEntryValue];
            }
            else if (typeof currentRecordPointer === "undefined") {
                throw new DetailedError('current-value-not-given', `To update a non-unique key, the current value must be passed as parameter`);
            }
            else {
                let valueIndex = entry.values.findIndex(val => _compareBinary(val.recordPointer, currentRecordPointer));
                if (!~valueIndex) { 
                    throw new DetailedError('key-value-pair-not-found', `Key/value combination to update not found (key: "${key}") `); 
                }
                entry.values[valueIndex] = newEntryValue;
            }
            return this._writeLeaf(leaf);
        })
        .catch(err => {
            throw new DetailedError('update-value-failed', `Could not update value for key '${key}': ${err.message}`, err);
        });
    }

    /**
     * TODO: Rename this to eg "process", it does not perform a transaction: 
     * it executes all operations until execution fails.
     * @param {BinaryBPlusTreeTransactionOperation[]} operations 
     */
    transaction(operations) {
        return new Promise((resolve, reject) => {
            const success = () => {
                if (operations.length === 0) {
                    resolve();
                }
                else {
                    processNextOperation();
                }
            };
            const processNextOperation = () => {
                const op = operations.shift();
                let p;
                switch(op.type) {
                    case 'add': {
                        p = this.add(op.key, op.recordPointer, op.metadata);
                        break;
                    }
                    case 'remove': {
                        p = this.remove(op.key, op.recordPointer);
                        break;
                    }
                    case 'update': {
                        p = this.update(op.key, op.newValue.recordPointer, op.currentValue.recordPointer, op.newValue.metadata);
                        break;
                    }
                }
                p.then(success)
                .catch(reason => {
                    operations.unshift(op);
                    reject(reason);
                });
            };
            processNextOperation();
        });
    }

    /**
     * 
     * @param {number} fillFactor 
     * @returns {Promise<BPlusTree>}
     */
    toTree(fillFactor = 100) {
        return this.toTreeBuilder(fillFactor)
        .then(builder => {
            return builder.create();
        });
    }

    /**
     * @returns {Promise<BPlusTreeBuilder>} Promise that resolves with a BPlusTreeBuilder
     */
    toTreeBuilder(fillFactor) {
        const treeBuilder = new BPlusTreeBuilder(this.info.isUnique, fillFactor, this.info.metadataKeys);
        return this.getFirstLeaf()
        .then(leaf => {

            /**
             * 
             * @param {BinaryBPlusTreeLeaf} leaf 
             */
            const processLeaf = leaf => {
                leaf.entries.forEach(entry => {
                    // if (this.isUnique) {
                    //     const entryValue = entry.value;
                    //     treeBuilder.add(entry.key, entryValue.value, entryValue.metadata);
                    // }
                    // else {
                    entry.values.forEach(entryValue => treeBuilder.add(entry.key, entryValue.value, entryValue.metadata));
                    // }
                });
                if (leaf.getNext) {
                    return leaf.getNext().then(processLeaf);
                }
            };

            return processLeaf(leaf);
        })
        .then(() => {
            return treeBuilder;
        });
    }

    /**
     * BinaryBPlusTree.rebuild
     * @param {BinaryWriter} writer
     * @param {object} [options]
     * @param {number} [options.allocatedBytes] bytes that have been pre-allocated, enforces a max writable byte length
     * @param {number} [options.fillFactor=95] number between 0-100 indicating the percentage of node and leaf filling, leaves room for later adds to the tree. Default is 95
     * @param {boolean} [options.keepFreeSpace=true] whether free space for later node/leaf creation is kept or added. If allocatedBytes is not given (or 0), 10% free space will be used. Default is true
     * @param {boolean|number} [options.increaseMaxEntries=true] whether to increase the max amount of node/leaf entries (usually rebuilding is needed because of growth, so this might be a good idea). Default is true, will increase max entries with 10% (until the max of 255 is reached)
     * @param {{ byteLength?: number, totalEntries?: number, totalValues?: number, totalLeafs?: number, depth?: number, entriesPerNode?: number }} [options.treeStatistics] object that will be updated with statistics as the tree is written
     */
    rebuild(writer, options = { allocatedBytes: 0, fillFactor: 95, keepFreeSpace: true, increaseMaxEntries: true }) {
        
        if (!(writer instanceof BinaryWriter)) {
            throw new DetailedError('invalid-argument', `writer argument must be an instance of BinaryWriter`);
        }

        if (!this.info) {
            // Hasn't been initialized yet. Populate the info
            return this._getReader()
            .then(reader => {
                return this.rebuild(writer, options);
            })
        }

        const originalChunkSize = this._chunkSize;
        // this._chunkSize = 1024 * 1024; // Read 1MB at a time to speed up IO
        
        options = options || {};
        options.fillFactor = options.fillFactor || this.info.fillFactor || 95;
        options.keepFreeSpace = options.keepFreeSpace !== false;
        options.increaseMaxEntries = options.increaseMaxEntries !== false;
        options.treeStatistics = options.treeStatistics || { byteLength: 0, totalEntries: 0, totalValues: 0, totalLeafs: 0, depth: 0, entriesPerNode: 0 }
        if (typeof options.allocatedBytes === 'number') {
            options.treeStatistics.byteLength = options.allocatedBytes;
        }

        let maxEntriesPerNode = this.info.entriesPerNode;
        if (options.increaseMaxEntries && maxEntriesPerNode < 255) {
            // Increase nr of entries per node with 10%
            maxEntriesPerNode = Math.min(255, Math.round(maxEntriesPerNode * 1.1));
        }
        options.treeStatistics.entriesPerNode = maxEntriesPerNode;
        // let entriesPerLeaf = Math.round(maxEntriesPerNode * (options.fillFactor / 100));
        // let entriesPerNode = entriesPerLeaf;

        // How many entries does the tree have in total?
        // TODO: store this in this.info.totalEntries (and in binary file)
        const leafStats = {
            // debugEntries: [],
            totalEntries: 0,
            totalValues: 0,
            totalEntryBytes: 0,
            totalKeyBytes: 0,
            readLeafs: 0,
            readEntries: 0,
            writtenLeafs: 0,
            writtenEntries: 0,
            get averageEntryLength() {
                return Math.ceil(this.totalEntryBytes / this.totalEntries);
            },
            get averageKeyLength() {
                return Math.ceil(this.totalKeyBytes / this.totalEntries);
            }
        };
        const getKeySize = (key) => {
            if (typeof key === 'number' || key instanceof Date) { return 4; }
            if (typeof key === 'string') { return key.length; }
            if (typeof key === 'boolean') { return 1; }
        }
        let lock;
        let leafsSeen = 0;
        // console.log('Starting tree rebuild');
        return ThreadSafe.lock(this.id, { timeout: 15 * 60 * 1000 })
        .then(l => {
            lock = l;

            const getLeafStartKeys = (entriesPerLeaf) => {
                let leafStartKeys = [];
                let entriesFromLastLeafStart = 0;
                /** @param {BinaryBPlusTreeLeaf} leaf */
                function processLeaf(leaf) {
                    leafsSeen++;
                    // console.log(`Processing leaf with ${leaf.entries.length} entries, total=${totalEntries}`);
                    // leafStats.debugEntries.push(...leaf.entries);

                    if (leaf.entries.length === 0) {
                        // For leafs that were previously left empty (are now removed, see issue #5)
                        if (leaf.getNext) {
                            return leaf.getNext()
                            .then(processLeaf);
                        }
                        return;
                    }

                    leafStats.totalEntries += leaf.entries.length;
                    leafStats.totalValues += leaf.entries.reduce((total, entry) => total + entry.totalValues, 0);
                    leafStats.totalEntryBytes += leaf.length;
                    leafStats.totalKeyBytes += leaf.entries.reduce((total, entry) => total + getKeySize(entry.key), 0);
    
                    if (leafStartKeys.length === 0 || entriesFromLastLeafStart === entriesPerLeaf) {
                        // This is the first leaf being processed, or last leaf entries filled whole new leaf
                        leafStartKeys.push(leaf.entries[0].key);
                        entriesFromLastLeafStart = 0;
                    }
    
                    if (entriesFromLastLeafStart + leaf.entries.length <= entriesPerLeaf) {
                        // All entries fit into current leaf
                        entriesFromLastLeafStart += leaf.entries.length;
                    }
                    else {
                        // some of the entries fit in current leaf
                        let cutIndex = entriesPerLeaf - entriesFromLastLeafStart;
                        // new leaf starts at cutIndex
                        let firstLeafEntry = leaf.entries[cutIndex];
                        leafStartKeys.push(firstLeafEntry.key);
                        // How many entries for the new leaf do we have already?
                        entriesFromLastLeafStart = leaf.entries.length - cutIndex;
                        while (entriesFromLastLeafStart > entriesPerLeaf) {
                            // Too many for 1 leaf
                            cutIndex += entriesPerLeaf;
                            firstLeafEntry = leaf.entries[cutIndex];
                            leafStartKeys.push(firstLeafEntry.key);
                            entriesFromLastLeafStart = leaf.entries.length - cutIndex;
                        }
                    }
    
                    // console.log(`Processed ${leafsSeen} leafs in source tree`);
                    if (leaf.getNext) {
                        return leaf.getNext()
                        .then(processLeaf);
                    }
                }
                // Start processing leafs
                return this.getFirstLeaf()
                .then(processLeaf)
                .then(() => {
                    return leafStartKeys;
                });    
            }

            let lastLeaf = null;
            const getEntries = n => {
                // get next leaf entries, n can be ignored
                const processLeaf = leaf => {
                    // If leaf has extData, load it first
                    if (leaf.hasExtData && !leaf.extData.loaded) {
                        return leaf.extData.load()
                        .then(() => {
                            // Retry
                            return processLeaf(leaf);
                        });
                    }
                    lastLeaf = leaf;
                    leafStats.readLeafs++;
                    leafStats.readEntries += leaf.entries.length;
                    if (leaf.entries.length === 0 && leaf.getNext) {
                        // For leafs that were previously left empty (are now removed, see issue #5)
                        return leaf.getNext()
                        .then(processLeaf);
                    }
                    return leaf.entries;
                }
                if (!lastLeaf) {
                    return this.getFirstLeaf()
                    .then(processLeaf);
                }
                else if (lastLeaf && lastLeaf.getNext) {
                    return lastLeaf.getNext()
                    .then(processLeaf);
                }
                else {
                    return [];
                }
            }

            return BinaryBPlusTree.create({
                getLeafStartKeys,
                getEntries,
                writer,
                treeStatistics: options.treeStatistics,
                fillFactor: options.fillFactor,
                maxEntriesPerNode,
                isUnique: this.info.isUnique,
                metadataKeys: this.info.metadataKeys,
                allocatedBytes: options.allocatedBytes,
                keepFreeSpace: options.keepFreeSpace
            });

        })
        .then(() => {
            lock.release();

            options.treeStatistics.totalLeafs = leafStats.writtenLeafs;;
            options.treeStatistics.totalEntries = leafStats.totalEntries;
            options.treeStatistics.totalValues = leafStats.totalValues;

            this._chunkSize = originalChunkSize; // Reset chunk size to original
        });
        // .then(async results => {
        //     await this._testTree();
        //     return results;
        // });
    }

    /**
     * 
     * @param {object} options 
     * @param {(entriesPerLeaf: number) => Promise<any[]>} options.getLeafStartKeys
     * @param {(n: number) => Promise<{ key: any, values: any[]}[]>} options.getEntries
     * @param {BinaryWriter} options.writer
     * @param {object} options.treeStatistics
     * @param {number} [options.fillFactor = 100]
     * @param {number} [options.maxEntriesPerNode = 255]
     * @param {boolean} options.isUnique
     * @param {string[]} [options.metadataKeys]
     * @param {number} options.allocatedBytes
     * @param {boolean} [options.keepFreeSpace = true]
     */
    static create(options) {
        const writer = options.writer;

        if (typeof options.maxEntriesPerNode !== 'number') { options.maxEntriesPerNode = 255; }
        if (typeof options.fillFactor !== 'number') { options.fillFactor = 100; }
        let entriesPerLeaf = Math.round(options.maxEntriesPerNode * (options.fillFactor / 100));
        let entriesPerNode = entriesPerLeaf;

        return options.getLeafStartKeys(entriesPerLeaf)
        .then(leafStartKeys => {
            // Now we know how many leafs we will be building and what their first key values are
            const createLeafs = leafStartKeys.length;
            options.treeStatistics.totalLeafs = createLeafs;

            // Determine all parent node entry keys per level
            // example:
            // [1,2,3,4,5], [6,7,8,9,10], [11,12,13,14,15], [16,17,18,19,20], [21,22,23,24,25]
            // will get parent node:
            // [6,11,16,21]
            // A parent node has an entry for max [entriesPerNode+1] child node/leaf
            // We can use the 1st entries of the 2nd to [entriesPerNode]nd child nodes/leafs

            // example 2:
            // leafs: [1,2,3], [4,5,6], [7,8,9], [10,11,12]
            // nodes 1:    [4,>= (<7)], [10,>= (<infinity)]
            // nodes 0:         [7,>= (<infinity)]

            // example 3:
            // leafs: [1,2,3], [4,5,6], [7,8,9], [10,11,12], [13,14,15], [16,17,18], [19,20,21], [22,23,24], [25,26,27]
            // nodes 1:    [4,7,10,>= (<13)], [16,19,>= (<22)], [25,>= (<infinity)] 
            // nodes 0:         [13,22,>= (<infinity)]

            // First, create nodes pointing to the leafs and as many parent level nodes as needed
            let childLevelNodes = leafStartKeys;
            const levels = [];
            while (childLevelNodes.length > 1) {
                // Create another level
                childLevelNodes = childLevelNodes.reduce((nodes, child, index, arr) => {
                    let entriesLeft = arr.length - index;
                    var currentNode = nodes[nodes.length-1];
                    let isLast = 
                        index === arr.length - 1 // Literally the last child
                        || currentNode.entries.length === entriesPerNode // gt connection of this node
                        || (entriesLeft === 3 && currentNode.entries.length + entriesLeft > entriesPerNode); // early chop off gt connection to save entries for next node
             
                    if (isLast) {
                        // gt connection
                        let key = typeof child === 'object'
                            ? child.gtMaxKey // child is node
                            : arr[index+1]; // child is leaf start key
                        currentNode.gtMaxKey = key;
                        currentNode.gtChildIndex = index;
                        if (index < arr.length - 1) {
                            // More to come..
                            currentNode = { entries: [], gtChildIndex: -1, gtMaxKey: null };
                            nodes.push(currentNode);
                        }
                        // connections = 0;
                    }
                    else {
                        // lt connection
                        let key = typeof child === 'object'
                            ? child.gtMaxKey // child is node
                            : arr[index+1]; // child is leaf start key
                        currentNode.entries.push({ key, ltChildIndex: index });
                        // connections++;
                    }
                    return nodes;
                }, [{ entries: [], gtChildIndex: -1, gtMaxKey: null }]);
                levels.push(childLevelNodes);
            }
            
            options.treeStatistics.depth = levels.length;
            options.treeStatistics.writtenLeafs = 0;
            options.treeStatistics.writtenEntries = 0;

            // Now that we have the keys for each node level, we can start building the actual tree
            // Do this efficiently by reusing the level keys array, reducing them in size as we go

            // Write in this order:
            // 1) header
            // 2) all nodes, 
            // 3) all leafs,
            // 4) all nodes again with the right child pointers (or just the pointers),
            // 5) overwrite header with real data

            const builder = new BinaryBPlusTreeBuilder({
                uniqueKeys: options.isUnique,
                byteLength: options.allocatedBytes,
                maxEntriesPerNode: options.maxEntriesPerNode,
                freeBytes: options.keepFreeSpace ? 1 : 0,
                metadataKeys: options.metadataKeys,
                smallLeafs: WRITE_SMALL_LEAFS,
                fillFactor: options.fillFactor
            });

            // Create header
            let header = builder.getHeader();
            let index = header.length;
            const rootNodeIndex = index;
            const leafIndexes = [];
            let largestLeafLength = 0;

            return writer.append(header)
            .then(() => {

                // Write all node levels for the first time 
                // (lt/gt child index pointers won't make sense yet)
                let l = levels.length;
                const nextLevel = () => {
                    l--;
                    let nodes = levels[l];
                    let writes = [];
                    nodes.forEach(node => {
                        node.index = index; //writer.length;
                        let bytes = builder.createNode(
                            {
                                index: node.index,
                                entries: node.entries.map(entry => ({ key: entry.key, ltIndex: 0 })),
                                gtIndex: 0
                            },
                            { addFreeSpace: options.keepFreeSpace, allowMissingChildIndexes: true }
                        );
                        node.byteLength = bytes.length;
                        index += bytes.length;
                        let p = writer.append(bytes);
                        writes.push(p);
                    });
                    return Promise.all(writes)
                    .then(() => {
                        if (l > 0) { return nextLevel(); }
                    });
                };
                const writeNodes = () => {
                    if (levels.length === 0) {
                        // Small tree, there's only 1 leaf, no parent nodes
                        return; 
                    }
                    return nextLevel();
                }
                return writeNodes();
            })
            .then(() => {
                // Write all leafs
                let newLeafEntries = [];
                let prevIndex = 0;
                let currentLeafIndex = 0;
                let totalWrittenEntries = 0;
                const writeLeaf = (entries) => {
                    let emptyLeaf = false;
                    if (entries.length === 0 && leafStartKeys.length === 0) {
                        // Write an empty leaf
                        emptyLeaf = true;
                    }
                    
                    // console.log(`Writing leaf with ${entries.length} entries at index ${index}, keys range: ["${entries[0].key}", "${entries[entries.length-1].key}"]`)
                    console.assert(entries.every((entry, index, arr) => index === 0 || _isMoreOrEqual(entry.key, arr[index-1].key)), 'Leaf entries are not sorted ok');
                    let i = leafIndexes.length;
                    console.assert(emptyLeaf || _isEqual(leafStartKeys[i], entries[0].key), `first entry for leaf has wrong key, must be ${leafStartKeys[i]}!`);

                    leafIndexes.push(index);
                    const isLastLeaf = emptyLeaf || leafIndexes.length === leafStartKeys.length;
                    const newLeaf = builder.createLeaf(
                        { index, prevIndex, nextIndex: isLastLeaf ? 0 : 'adjacent', entries },
                        { addFreeSpace: options.keepFreeSpace }
                    );
                    largestLeafLength = Math.max(largestLeafLength, newLeaf.length);
                    prevIndex = index;
                    index += newLeaf.length;
                    totalWrittenEntries += entries.length;
                    return writer.append(newLeaf);
                }

                const flush = (flushAll = false) => {
                    if (newLeafEntries.length < 0) { 
                        console.assert(totalWrittenEntries === leafStats.totalEntries, 'Written entries does not match nr of read entries!')
                        return; 
                    }
                    let cutEntryKey = leafStartKeys[currentLeafIndex+1];
                    let entries;
                    if (typeof cutEntryKey === 'undefined') {
                         // Last batch
                         if (flushAll) {
                             console.assert(newLeafEntries.length <= entriesPerLeaf, 'check logic');
                             entries = newLeafEntries.splice(0);
                         }
                         else {
                             return; // Wait for remaining entries
                         }
                    }
                    else {
                        let cutEntryIndex = newLeafEntries.findIndex(entry => _isEqual(entry.key, cutEntryKey));
                        if (cutEntryIndex === -1) {
                            // Not enough entries yet
                            console.assert(!flushAll, 'check logic');
                            console.assert(newLeafEntries.length <= entriesPerLeaf, 'check logic!');
                            return;
                        }
                        entries = newLeafEntries.splice(0, cutEntryIndex);
                    }

                    options.treeStatistics.writtenLeafs++;
                    options.treeStatistics.writtenEntries += entries.length;

                    currentLeafIndex++;
                    return writeLeaf(entries)
                    .then(() => {
                        // Write more
                        if (newLeafEntries.length >= entriesPerLeaf || (flushAll && newLeafEntries.length > 0)) {
                            return flush(flushAll);
                        }
                    })
                };

                const processEntries = (entries) => {
                    if (entries.length === 0) { 
                        return flush(true); // done!
                    }
                    // options.treeStatistics.readEntries += entries.length;

                    console.assert(entries.every((entry, index, arr) => index === 0 || _isMoreOrEqual(entry.key, arr[index-1].key)), 'Leaf entries are not sorted ok');
                    console.assert(newLeafEntries.length === 0 || _isMore(entries[0].key, newLeafEntries[newLeafEntries.length-1].key), 'adding entries will corrupt sort order');
                    newLeafEntries.push(...entries);

                    let writePromise = flush(false);
                    let readNextPromise = options.getEntries(options.maxEntriesPerNode);
                    return Promise.all([readNextPromise, writePromise])
                    .then(results => {
                        let entries = results[0];
                        return processEntries(entries);
                    });
                }
                
                return options.getEntries(options.maxEntriesPerNode)
                .then(processEntries);
            })
            // .then(() => {
            //     // // DEbug tree writing
            //     // let debugTree = levels.map(nodes => nodes.slice()); // copy
            //     // debugTree.forEach((nodes, levelIndex) => {
            //     //     debugTree[levelIndex] = nodes.map(node => {
            //     //         return { 
            //     //             node,
            //     //             gtChild: levelIndex === 0 
            //     //                 ? leafStartKeys[node.gtChildIndex]
            //     //                 : debugTree[levelIndex-1][node.gtChildIndex],
            //     //             entries: node.entries.map(entry => {
            //     //                 return {
            //     //                     key: entry.key, 
            //     //                     ltChild: levelIndex === 0 
            //     //                         ? leafStartKeys[entry.ltChildIndex]
            //     //                         : debugTree[levelIndex-1][entry.ltChildIndex]
            //     //                 };
            //     //             })
            //     //         };
            //     //     });
            //     // });
            //     // debugTree.reverse(); // Now top-down
            //     // console.error(debugTree);
            //     // debugTree.forEach((nodes, levelIndex) => {
            //     //     let allEntries = nodes.map(node => `[${node.entries.map(entry => entry.key).join(',')}]`).join(' | ')
            //     //     console.error(`node level ${levelIndex}: ${allEntries}`);
            //     // });
            //     // console.error(`leafs: [${leafStartKeys.join(`..] | [`)}]`);
            // })
            .then(() => {
                // Now adjust the header data & write free bytes
                let byteLength = index;
                let freeBytes = 0;
                if (options.allocatedBytes > 0) {
                    freeBytes = options.allocatedBytes - byteLength;
                    byteLength = options.allocatedBytes;
                }
                else {
                    // Use 10% free space, or the largest leaf length + 10%, whichever is the largest
                    freeBytes = Math.max(Math.ceil(byteLength * 0.1), Math.ceil(largestLeafLength * 1.1));
                    // console.log(`new tree gets ${freeBytes} free bytes`);
                    byteLength += freeBytes;
                }

                // Rebuild header
                builder.byteLength = byteLength; // - header.length;
                builder.freeBytes = freeBytes;
                header = builder.getHeader();

                options.treeStatistics.byteLength = byteLength;
                options.treeStatistics.freeBytes = freeBytes;

                // Append free space bytes
                const bytesPerWrite = 1024 * 100; // 100KB per write seems fair?
                const writes = Math.ceil(builder.freeBytes / bytesPerWrite);

                var writePromise = Promise.resolve();
                for (let i = 0; i < writes; i++) {
                    const length = i + 1 < writes
                        ? bytesPerWrite
                        : builder.freeBytes % bytesPerWrite;
                    const zeroes = new Uint8Array(length);
                    writePromise = writePromise.then(() => {
                        return writer.append(zeroes);
                    });
                }
                
                return writePromise;
            })
            .then(() => {
                // Done appending data, close stream
                return writer.end();
            })
            .then(() => {
                // Overwrite header
                let writes = [
                    writer.write(header, 0)
                ];

                // Assign all nodes' child indexes to the real file indexes
                levels.forEach((nodes, index) => {
                    nodes.forEach(node => {
                        if (index === 0) {
                            // first level references leafs
                            node.gtChildIndex = leafIndexes[node.gtChildIndex];
                            node.entries.forEach(entry => {
                                entry.ltChildIndex = leafIndexes[entry.ltChildIndex];
                            });
                        }
                        else {
                            // use node index on next (lower) level
                            node.gtChildIndex = levels[index-1][node.gtChildIndex].index;
                            node.entries.forEach(entry => {
                                entry.ltChildIndex = levels[index-1][entry.ltChildIndex].index;
                            });
                        }
                        // Regenerate bytes
                        let bytes = builder.createNode(
                            {
                                index: node.index,
                                entries: node.entries.map(entry => ({ key: entry.key, ltIndex: entry.ltChildIndex })),
                                gtIndex: node.gtChildIndex
                            },
                            { addFreeSpace: options.keepFreeSpace, maxLength: node.byteLength }
                        );
                        // And overwrite them in the file                        
                        let p = writer.write(bytes, node.index);
                        writes.push(p);
                    });
                });

                return Promise.all(writes);
            });
        });
    }

    /**
     * Creates a binary tree from a stream of entries.
     * An entry stream must be a binary data stream containing only leaf entries
     * a leaf entry can be created using BinaryBPlusTree.createStreamEntry(key, values)
     * @param {BinaryReader} reader 
     * @param {BinaryWriter} writer 
     * @param {object} options
     * @param {object} options.treeStatistics
     * @param {number} [options.fillFactor = 100]
     * @param {number} [options.maxEntriesPerNode = 255]
     * @param {boolean} options.isUnique
     * @param {string[]} [options.metadataKeys]
     * @param {number} options.allocatedBytes
     * @param {boolean} [options.keepFreeSpace = true]
     */
    static createFromEntryStream(reader, writer, options) {
        // Steps:
        // 1 - loop through all entries to calculate leaf start keys
        // 2 - create nodes
        // 3 - create leafs
        // const entriesPerLeaf = Math.round(options.maxEntriesPerNode * (options.fillFactor / 100));

        const getLeafStartKeys = (entriesPerLeaf) => {
            options.treeStatistics.totalEntries = 0;
            return reader.init()
            .then(() => {
                const leafStartKeys = [];
                const readNext = () => {
                    options.treeStatistics.totalEntries++;
                    const entryIndex = reader.sourceIndex;
                    return reader.getUint32()
                    .then(entryLength => {
                        if (options.treeStatistics.totalEntries % entriesPerLeaf === 1) {
                            return reader.getValue()
                            .then(key => {
                                // console.log(key);
                                leafStartKeys.push(key);
                                return reader.go(entryIndex + entryLength)
                                .then(readNext);
                            })
                        }
                        else {
                            // skip reading this entry's key
                            return reader.go(entryIndex + entryLength)
                            .then(readNext);
                        }
                    })
                    .catch(err => {
                        // EOF?
                        if (err.code !== 'EOF') {
                            throw err;
                        }
                    });
                };
                return readNext()
                .then(() => {
                    return reader.go(0); // Reset
                })
                .then(() => {
                    return leafStartKeys;
                });
            });
        };

        const getEntries = n => {
            // read n entries
            const entries = [];
            reader.chunkSize = 1024 * 1024; // 1MB chunks
            const readNext = () => {
                // read entry_length:
                return reader.getUint32()
                .then(entryLength => {
                    return reader.get(entryLength - 4); // -4 because entry_length is 4 bytes
                })
                .then(buffer => {
                    // read key:
                    let k = BinaryReader.readValue(buffer, 0);
                    const entry = {
                        key: k.value,
                        values: []
                    };
                    let index = k.byteLength;
                    // read values_length
                    const totalValues = BinaryReader.readUint32(buffer, index);
                    index += 4;
                    for(let i = 0; i < totalValues; i++) {
                        // read value_length
                        const valueLength = BinaryReader.readUint32(buffer, index);
                        index += 4;
                        const val = buffer.slice(index, index + valueLength);
                        index += valueLength;
                        // val contains rp_length, rp_data, metadata
                        const rpLength = val[0]; // rp_length
                        const recordPointer = val.slice(1, 1 + rpLength); // rp_data
                        // metadata:
                        let valIndex = 1 + rpLength;
                        const metadata = {};
                        for (let j = 0; j < options.metadataKeys.length; j++) {
                            const mdKey = options.metadataKeys[j];
                            const mdValue = BinaryReader.readValue(val, valIndex);
                            metadata[mdKey] = mdValue.value;
                            valIndex += mdValue.byteLength;
                        }
                        const value = {
                            recordPointer,
                            metadata
                        };
                        entry.values.push(value);
                    }
                    entries.push(entry);
                    if (entries.length < n) {
                        return readNext();
                    }
                })
                .catch(err => {
                    // EOF?
                    if (err.code !== 'EOF') {
                        throw err;
                    }
                });
            };
            return readNext()
            .then(() => {
                return entries;
            });
        };

        return BinaryBPlusTree.create({ 
            getLeafStartKeys,
            getEntries,
            writer,
            treeStatistics: options.treeStatistics,
            fillFactor: options.fillFactor,
            allocatedBytes: options.allocatedBytes,
            isUnique: options.isUnique,
            keepFreeSpace: options.keepFreeSpace,
            maxEntriesPerNode: options.maxEntriesPerNode,
            metadataKeys: options.metadataKeys
        });
    }

}

class BinaryBPlusTreeNodeInfo {
    // @param {{ isLeaf: boolean, bytes: number[], index: number, length: number, free: number, parentNode?: BinaryBPlusTreeNode, parentEntry?: BinaryBPlusTreeNodeEntry  }} info 
    /**
     * 
     * @param {object} info
     * @param {boolean} info.isLeaf whether this is a leaf or node
     * @param {boolean} info.hasExtData whether this leaf has some external data
     * @param {number[]} info.bytes data bytes, excluding header & free bytes
     * @param {number} [info.index] deprecated: use sourceIndex instead
     * @param {number} info.dataIndex index relative to the start of data bytes
     * @param {number} info.length total byte length of the node, including header & free bytes
     * @param {number} info.free number of free bytes at the end of the data
     * @param {number} info.sourceIndex start index of the node/leaf
     * @param {BinaryBPlusTree} [info.tree]
     * @param {BinaryBPlusTreeNode} [info.parentNode]
     * @param {BinaryBPlusTreeNodeEntry} [info.parentEntry]
     */
    constructor(info) {
        this.tree = info.tree;
        this.isLeaf = info.isLeaf;
        this.hasExtData = info.hasExtData || false;
        this.bytes = info.bytes;
        if (typeof info.sourceIndex === 'undefined') {
            info.sourceIndex = info.index;
        }
        this.sourceIndex = info.sourceIndex;
        if (typeof info.dataIndex === 'undefined') {
            info.dataIndex = this.sourceIndex + 9; // node/leaf header is 9 bytes
        }
        this.dataIndex = info.dataIndex;
        this.length = info.length;
        this.free = info.free;
        this.parentNode = info.parentNode;
        this.parentEntry = info.parentEntry;
    }
    get index() {
        return this.sourceIndex;
    }
    set index(value) {
        this.sourceIndex = value;
    }
}

class BinaryBPlusTreeNode extends BinaryBPlusTreeNodeInfo {
    /**
     * 
     * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
     */
    constructor(nodeInfo) {
        super(nodeInfo);

        /** @type {BinaryBPlusTreeNodeEntry[]} */
        this.entries = [];
        /** @type {number} */
        this.gtChildOffset = null;

        /** @type {() => Promise<BinaryBPlusTreeNodeInfo} */
        this.getGtChild = () => {
            return Promise.reject(new DetailedError('method-not-overridden', `getGtChild must be overridden`));
        };
    }
}

class BinaryBPlusTreeNodeEntry {
    /**
     * 
     * @param {string|number|boolean|Date} key
     */
    constructor(key) {
        this.key = key;

        /** @type {number} */
        this.ltChildOffset = null;

        /** @type {() => Promise<BinaryBPlusTreeNodeInfo} */
        this.getLtChild = () => {
            return Promise.reject(new DetailedError('method not overridden', `getLtChild must be overridden`));
        }
    }
}

// class BinaryBPlusTreeLeafExtData {
//     /**
//      * 
//      * @param {object} [info]
//      * @param {number} [info.length=0] 
//      * @param {number} [info.freeBytes=0] 
//      * @param {boolean} [info.loaded]
//      * @param {()=>Promise<void>} [info.load] 
//      */
//     constructor(info) {
//         this.length = typeof info.length === 'number' ? info.length : 0;
//         this.freeBytes = typeof info.freeBytes === 'number' ? info.freeBytes : 0;
//         this.loaded = typeof info.loaded === 'boolean' ? info.loaded : false;
//         if (typeof info.load === 'function') {
//             this.load = info.load;
//         }
//     }
//     /**
//      * MUST BE OVERRIDEN: Makes sure all extData blocks are read. Needed when eg rebuilding.
//      */
//     load() {
//         throw new Error('BinaryBPlusTreeLeaf.extData.load must be overriden');
//     }
// }

class BinaryBPlusTreeLeaf extends BinaryBPlusTreeNodeInfo {
    /**
     * @param {BinaryBPlusTreeNodeInfo} nodeInfo 
     */
    constructor(nodeInfo) {
        console.assert(typeof nodeInfo.hasExtData === 'boolean', 'nodeInfo.hasExtData must be specified');
        super(nodeInfo);
                
        this.prevLeafOffset = 0;
        this.nextLeafOffset = 0;
        this.extData = {
            length: 0,
            freeBytes: 0,
            loaded: false,
            load() {
                // Make sure all extData blocks are read. Needed when eg rebuilding
                throw new DetailedError('method-not-overridden', 'BinaryBPlusTreeLeaf.extData.load must be overriden');
            }
        };

        /** @type {BinaryBPlusTreeLeafEntry[]} */
        this.entries = [];

        /** @type {() => Promise<BinaryBPlusTreeLeaf>?} only present if there is a previous leaf */
        this.getPrevious = undefined;
        /** @type {() => Promise<BinaryBPlusTreeLeaf>?} only present if there is a next leaf */
        this.getNext = undefined;
    }

    static get prevLeafPtrIndex() { return 9; }
    static get nextLeafPtrIndex() { return 15; }

    static getPrevLeafOffset(leafIndex, prevLeafIndex) {
        return prevLeafIndex > 0 
            ? prevLeafIndex - leafIndex - 9
            : 0;
    }

    static getNextLeafOffset(leafIndex, nextLeafIndex) {
        return nextLeafIndex > 0 
            ? nextLeafIndex - leafIndex - 15 
            : 0;
    }

    get prevLeafIndex() {
        return this.prevLeafOffset !== 0 
            ? this.index + 9 + this.prevLeafOffset 
            : 0;
    }
    set prevLeafIndex(newIndex) {
        this.prevLeafOffset = newIndex > 0 
            ? newIndex - this.index  - 9
            : 0;
    }

    get nextLeafIndex() {
        return this.nextLeafOffset !== 0 
            ? this.index + (this.tree.info.hasLargePtrs ? 15 : 13) + this.nextLeafOffset 
            : 0;
    }
    set nextLeafIndex(newIndex) {
        this.nextLeafOffset = newIndex > 0 
            ? newIndex - this.index - (this.tree.info.hasLargePtrs ? 15 : 13) 
            : 0;
    }

    findEntryIndex(key) {
        return this.entries.findIndex(entry => _isEqual(entry.key, key));
    }

    findEntry(key) {
        return this.entries[this.findEntryIndex(key)];
    }
}

class BinaryBPlusTreeLeafEntryValue {
    /**
     * 
     * @param {number[]|Uint8Array} recordPointer used to be called "value", renamed to prevent confusion
     * @param {object} [metadata] 
     */
    constructor(recordPointer, metadata) {
        this.recordPointer = recordPointer;
        this.metadata = metadata;
    }

    /** @deprecated use .recordPointer instead */
    get value() {
        return this.recordPointer;
    }
}

class BinaryBPlusTreeLeafEntry {
    /**
     * 
     * @param {string|number|boolean|Date} key 
     * @param {Array<BinaryBPlusTreeLeafEntryValue>} values Array of binary values - NOTE if the tree has unique values, it must always wrap the single value in an Array: [value]
     */
    constructor(key, values) {
        this.key = key;
        this.values = values;
    }

    /**
     * @deprecated use .values[0] instead
     */
    get value() {
        return this.values[0];
    }

    get totalValues() {
        if (typeof this._totalValues === 'number') { return this._totalValues; }
        if (this.extData) { return this.extData.totalValues; }
        return this.values.length;
    }

    set totalValues(nr) {
        this._totalValues = nr;
    }
}

class BinaryBPlusTreeTransactionOperation {
    constructor(operation) {
        // operation.key = _normalizeKey(operation.key); // if (_isIntString(operation.key)) { operation.key = parseInt(operation.key); }
        /** @type {string} */
        this.type = operation.type;
        /** @type {string|number|boolean|Date|undefined} */
        this.key = operation.key;
        if (operation.type === 'add' || operation.type === 'remove') {
            /** @type {number[]|Uint8Array} */
            this.recordPointer = operation.recordPointer;
        }
        if (operation.type === 'add') {
            this.metadata = operation.metadata;
        }
        if (operation.type === 'update') {
            /** @type {BinaryBPlusTreeLeafEntryValue} */
            this.newValue = operation.newValue;
            /** @type {BinaryBPlusTreeLeafEntryValue} */
            this.currentValue = operation.currentValue;
        }
    }
    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer 
     * @param {object} metadata
     */
    static add(key, recordPointer, metadata) {
        return new BinaryBPlusTreeTransactionOperation({ type: 'add', key, recordPointer, metadata });
    }
    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {BinaryBPlusTreeLeafEntryValue} newValue 
     * @param {BinaryBPlusTreeLeafEntryValue} currentValue 
     * @param {object} metadata
     */
    static update(key, newValue, currentValue, metadata) {
        return new BinaryBPlusTreeTransactionOperation({ type: 'update', key, newValue, currentValue, metadata });
    }
    /**
     * @param {string|number|boolean|Date|undefined} key 
     * @param {number[]|Uint8Array} recordPointer
     */
    static remove(key, recordPointer) {
        return new BinaryBPlusTreeTransactionOperation({ type: 'remove', key, recordPointer });
    }
}

BinaryBPlusTree.EntryValue = BinaryBPlusTreeLeafEntryValue;
BinaryBPlusTree.TransactionOperation = BinaryBPlusTreeTransactionOperation;

class BinaryWriter {
    /**
     * 
     * @param {fs.WriteStream} stream 
     * @param {((data: number[]|Uint8Array, position: number) => Promise<void>)} writeFn
     */
    constructor(stream, writeFn) {
        this._stream = stream;
        this._write = writeFn;
        this._written = 0;
    }

    static forArray(bytes) {
        let stream = {
            write(data) {
                for (let i = 0; i < data.byteLength; i++) {
                    bytes.push(data[i]);
                }
                return true; // let caller know its ok to continue writing
            },
            end(callback) {
                callback();
            }
        };
        const writer = new BinaryWriter(stream, (data, position) => {
            for(let i = bytes.length; i < position; i++) {
                bytes[i] = 0; // prevent "undefined" bytes when writing to a position greater than current array length
            }
            for(let i = 0; i < data.byteLength; i++) {
                bytes[position + i] = data[i];
            }
            return Promise.resolve();
        });  
        return writer;      
    }

    static forFunction(writeFn) {
        const _maxSimultaniousWrites = 50;
        let _currentPosition = 0;
        let _pendingWrites = 0;
        let _drainCallbacks = [];
        let _endCallback = null;
        let _ended = false;
        // let _currentWrite;
        // let stream = {
        //     write(data) {
        //         // Append data
        //         let go = () => {
        //             return writeFn(data, _currentPosition)
        //             .then(() => {
        //                 _endCallback && _endCallback();
        //             });
        //         };
        //         _currentWrite = _currentWrite ? _currentWrite.then(go) : go();
        //         return true;
        //     },
        //     end(callback) {
        //         if (_ended) { throw new Errow(`end can only be called once`); }
        //         _ended = true;
        //         _endCallback = callback;
        //         _currentWrite = _currentWrite.then(callback);
        //     },
        //     once(event, callback) {
        //         console.assert(event === 'drain', 'Custom stream can only handle "drain" event');
        //         // _drainCallbacks.push(callback);
        //         _currentWrite = _currentWrite.then(callback);
        //     }            
        // };
        // const writer = new BinaryWriter(stream, (data, position) => {
        //     let go = () => {
        //         return writeFn(data, position);
        //     };
        //     _currentWrite = _currentWrite ? _currentWrite.then(go) : go();
        //     return _currentWrite;
        // });

        let stream = {
            write(data) {
                console.assert(!_ended, `streaming was ended already!`);
                if (_pendingWrites === _maxSimultaniousWrites) {
                    console.warn('Warning: you should wait for "drain" event before writing new data!');
                }
                // console.assert(_pendingWrites < _maxSimultaniousWrites, 'Wait for "drain" event before writing new data!');
                _pendingWrites++;
                const success = () => {
                    _pendingWrites--;
                    if (_ended && _pendingWrites === 0) {
                        _endCallback();
                    }
                    let drainCallback = _drainCallbacks.shift();
                    drainCallback && drainCallback();
                };
                const fail = (err) => {
                    console.error(`Failed to write to stream: ${err.message}`);
                    success();
                }

                writeFn(data, _currentPosition)
                .then(success)
                .catch(fail);

                _currentPosition += data.byteLength;
                let ok = _pendingWrites < _maxSimultaniousWrites;
                return ok; // let caller know if its ok to continue writing
            },
            end(callback) {
                if (_ended) { throw new Errow(`end can only be called once`); }
                _ended = true;
                _endCallback = callback;
                if (_pendingWrites === 0) {
                    callback();
                }
            },
            once(event, callback) {
                console.assert(event === 'drain', 'Custom stream can only handle "drain" event');
                _drainCallbacks.push(callback);
            }
        };
        const writer = new BinaryWriter(stream, (data, position) => {
            return writeFn(data, position);
        });
        return writer;      
    }

    get length() { return this._written; }
    get queued() { return this._written - this._stream.bytesWritten; }

    /**
     * 
     * @param {number[]|Uint8Array|Buffer} data 
     */
    append(data) {
        if (data instanceof Array) {
            data = Uint8Array.from(data);
        }
        return new Promise(resolve => {
            const ok = this._stream.write(data);
            this._written += data.byteLength;
            if (!ok) {
                this._stream.once('drain', resolve);
            }
            else {
                resolve(); // process.nextTick(resolve);
            }
        });
    }

    write(data, position) {
        if (data instanceof Array) {
            data = Uint8Array.from(data);
        }
        return this._write(data, position);
    }

    end() {
        return new Promise(resolve => {
            this._stream.end(resolve);
            // writer.stream.on('finish', resolve);
        });
    }

    static getBytes(value) {
        return BinaryBPlusTreeBuilder.getKeyBytes(value);
    }
    static numberToBytes(number) {
        return numberToBytes(number);
    }
    static bytesToNumber(bytes) {
        return bytesToNumber(bytes);
    }
    static writeUint32(number, bytes, index) {
        return _writeByteLength(bytes, index, number);
    }
    static writeInt32(signedNumber, bytes, index) {
        return _writeSignedNumber(bytes, index, signedNumber);
    }
}

class BinaryBPlusTreeBuilder {
    constructor(options = { uniqueKeys: true, smallLeafs: WRITE_SMALL_LEAFS, maxEntriesPerNode: 3, fillFactor: 95, metadataKeys: [], byteLength: 0, freeBytes: 0 }) {
        this.uniqueKeys = options.uniqueKeys;
        this.maxEntriesPerNode = options.maxEntriesPerNode;
        this.metadataKeys = options.metadataKeys;
        this.byteLength = options.byteLength;
        this.freeBytes = options.freeBytes;
        this.smallLeafs = options.smallLeafs;
        this.fillFactor = options.fillFactor;
    }

    getHeader() {
        const indexTypeFlags = 
              (this.uniqueKeys ? FLAGS.UNIQUE_KEYS : 0) 
            | (this.metadataKeys.length > 0 ? FLAGS.HAS_METADATA : 0)
            | (this.freeBytes > 0 ? FLAGS.HAS_FREE_SPACE : 0)
            | (typeof this.fillFactor === 'number' && this.fillFactor > 0 && this.fillFactor <= 100 ? FLAGS.HAS_FILL_FACTOR : 0)
            | (this.smallLeafs === true ? FLAGS.HAS_SMALL_LEAFS : 0)
            | FLAGS.HAS_LARGE_PTRS;
        const bytes = [
            // byte_length:
            0, 0, 0, 0,
            // index_type:
            indexTypeFlags,
            // max_node_entries:
            this.maxEntriesPerNode
        ];
        // update byte_length:
        _writeByteLength(bytes, 0, this.byteLength);

        if (this.fillFactor > 0 && this.fillFactor <= 100) {
            // fill_factor:
            bytes.push(this.fillFactor);
        }

        if (this.freeBytes > 0) {
            // free_byte_length:
            _writeByteLength(bytes, bytes.length, this.freeBytes);
        }

        if (this.metadataKeys.length > 0) {
            // metadata_keys:
            const index = bytes.length;
            bytes.push(0, 0, 0, 0); // metadata_length

            // metadata_key_count:
            bytes.push(this.metadataKeys.length);

            this.metadataKeys.forEach(key => {
                // metadata_key:
                bytes.push(key.length); // metadata_key_length
                // metadata_key_name:
                for (let i=0; i < key.length; i++) {
                    bytes.push(key.charCodeAt(i));
                }
            });

            // update metadata_length:
            const length = bytes.length - index - 4;
            _writeByteLength(bytes, index, length);
        }

        return bytes;
    }

    /**
     * 
     * @param {{ index: number, gtIndex: number, entries: { key: any, ltIndex: number }[]}} info 
     * @param {{ addFreeSpace: boolean, maxLength?: number, allowMissingChildIndexes: false }} options 
     */
    createNode(info, options = { addFreeSpace: true, maxLength: 0 }) {

        console.assert(info.entries.length > 0, `node has no entries!`);

        let bytes = [
            // byte_length:
            0, 0, 0, 0,
            0, // is_leaf (no)
            // free_byte_length:
            0, 0, 0, 0
        ];
        
        // entries_length:
        bytes.push(info.entries.length);

        // entries:
        info.entries.forEach(entry => {
            let keyBytes = BinaryBPlusTreeBuilder.getKeyBytes(entry.key);
            bytes.push(...keyBytes);

            // lt_child_ptr: recalculate offset
            console.assert(entry.ltIndex >= 0, `node entry "${entry.key}" has ltIndex < 0: ${entry.ltIndex}`);
            let ltChildOffset = entry.ltIndex === 0 ? 0 : entry.ltIndex - 5 - (info.index + bytes.length);
            console.assert(options.allowMissingChildIndexes || ltChildOffset !== 0, `A node entry's ltChildOffset must ALWAYS be set!`);
            _writeSignedOffset(bytes, bytes.length, ltChildOffset, true);
        });
        
        // gt_child_ptr: calculate offset
        let gtChildOffset = info.gtIndex === 0 ? 0 : info.gtIndex - 5 - (info.index + bytes.length);
        console.assert(options.allowMissingChildIndexes || gtChildOffset !== 0, `A node's gtChildOffset must ALWAYS be set!`);
        _writeSignedOffset(bytes, bytes.length, gtChildOffset, true);

        let byteLength = bytes.length;
        if (options.maxLength > 0 && byteLength > options.maxLength) {
            throw new DetailedError('max-node-size-reached', `Node byte size grew above maximum of ${options.maxLength}`);
        }

        if (options.addFreeSpace) {
            let freeSpace = 0;
            if (options.maxLength > 0) {
                freeSpace = options.maxLength - byteLength;
                byteLength = options.maxLength;
            }
            else {
                let freeEntries = this.maxEntriesPerNode - info.entries.length;
                let avgEntrySize = Math.ceil((byteLength - 14) / info.entries.length);
                // freeSpace = freeEntries * avgEntrySize;
                freeSpace = Math.ceil(freeEntries * avgEntrySize * 1.1) // + 10%
                byteLength += freeSpace;
            }

            // Add free space zero bytes
            for (let i = 0; i < freeSpace; i++) {
                bytes.push(0);
            }

            // update free_byte_length:
            _writeByteLength(bytes, 5, freeSpace);
        }

        // update byte_length:
        _writeByteLength(bytes, 0, byteLength);

        return bytes;
    }

    /**
     * 
     * @param {{ index: number, prevIndex: number, nextIndex: number|'adjacent', entries: BinaryBPlusTreeLeafEntry[], extData: { length: number, freeBytes: number, rebuild?: boolean } }} info 
     * @param {{ addFreeSpace: boolean, maxLength?: number, addExtData: (pointerIndex: number, data: Uint8Array) => void }} options 
     * @returns {Uint8Array} bytes
     */
    createLeaf(info, options = { addFreeSpace: true }) {

        // console.log(`Creating leaf for entries "${info.entries[0].key}" to "${info.entries.slice(-1)[0].key}" (${info.entries.length} entries, ${info.entries.reduce((total, entry) => total + entry.values.length, 0)} values)`);

        const tree = new BPlusTree(this.maxEntriesPerNode, this.uniqueKeys, this.metadataKeys);
        const leaf = new BPlusTreeLeaf(tree);
        info.entries.forEach(entry => {
            const key = entry.key;
            // if (typeof key === 'undefined') {
            //     console.warn(`undefined key being written to leaf`);
            // }
            // const leafEntry = new BPlusTreeLeafEntry(leaf, key);
            // leafEntry.values = entry.values;
            // leaf.entries.push(leafEntry);
            leaf.entries.push(entry);
        });

        let hasExtData = typeof info.extData === 'object' && info.extData.length > 0;
        const bytes = new Uint8ArrayBuilder([
            0, 0, 0, 0, // byte_length
            FLAGS.IS_LEAF | (hasExtData ? FLAGS.LEAF_HAS_EXT_DATA : 0), // leaf_flags: has_ext_data, is_leaf (yes)
            0, 0, 0, 0, // free_byte_length
        ]);
        const leafFlagsIndex = 4;

        // prev_leaf_ptr:
        let prevLeafOffset = info.prevIndex === 0 ? 0 : info.prevIndex - (info.index + 9);
        bytes.writeInt48(prevLeafOffset); // _writeSignedOffset(bytes, bytes.length, prevLeafOffset, true);

        // next_leaf_ptr:
        let nextLeafOffset = info.nextIndex === 0 ? 0 : info.nextIndex === 'adjacent' ? 0 : info.nextIndex - (info.index + 15);
        bytes.writeInt48(nextLeafOffset); //_writeSignedOffset(bytes, bytes.length, nextLeafOffset, true);

        const extDataHeaderIndex = bytes.length;
        bytes.push(
            0, 0, 0, 0, // ext_byte_length
            0, 0, 0, 0  // ext_free_byte_length
        );

        // entries_length:
        bytes.push(info.entries.length);

        const moreDataBlocks = [];

        // entries:
        info.entries.forEach(entry => {
            let keyBytes = BinaryBPlusTreeBuilder.getKeyBytes(entry.key);
            bytes.push(...keyBytes);

            // val_length:
            const valLengthIndex = bytes.length;
            if (hasExtData && info.extData.rebuild && entry.extData && !entry.extData.loaded) {
                throw new DetailedError('ext-data-not-loaded', `extData cannot be rebuilt if an entry's extData isn't loaded`)
            }
            if (hasExtData && entry.extData && !info.extData.rebuild) {
                // this entry has external value data (leaf is being overwritten), 
                // use existing details

                // val_length:
                bytes.push(FLAGS.ENTRY_HAS_EXT_DATA);

                if (!this.uniqueKeys) {
                    // value_list_length:
                    bytes.writeUint32(entry.extData.totalValues); // _writeByteLength(bytes, bytes.length, entry.extData.totalValues);
                }

                // ext_data_ptr:
                bytes.writeUint32(entry.extData.leafOffset); // _writeByteLength(bytes, bytes.length, entry.extData.leafOffset);

                return; // next!
            }
            else if (this.smallLeafs) {
                // val_length: (small)
                bytes.push(0);
            }
            else {
                // val_length: (large)
                bytes.push(0, 0, 0, 0);
            }

            const valueBytes = new Uint8ArrayBuilder([]);

            /**
             * 
             * @param {BPlusTreeLeafEntryValue} entryValue 
             */
            const addValue = (entryValue) => {
                const { recordPointer, metadata } = entryValue;

                // value_length:
                valueBytes.push(recordPointer.length);

                // value_data:
                valueBytes.append(recordPointer);

                // metadata:
                this.metadataKeys.forEach(key => {
                    const metadataValue = metadata[key];
                    const mdBytes = BinaryBPlusTreeBuilder.getKeyBytes(metadataValue); // metadata_value has same structure as key, so getBinaryKeyData comes in handy here
                    valueBytes.append(mdBytes);
                });
            };

            if (this.uniqueKeys) {
                // value:
                addValue(entry.values[0]);
            }
            else {
                entry.values.forEach(entryValue => {
                    // value:
                    addValue(entryValue);
                });
            }

            if (this.smallLeafs && valueBytes.length > MAX_SMALL_LEAF_VALUE_LENGTH) {
                // Values too big for small leafs
                // Store value bytes in ext_data block

                if (!this.uniqueKeys) {
                    // value_list_length:
                    bytes.writeUint32(entry.values.length); // _writeByteLength(bytes, bytes.length, entry.values.length);
                }

                // ext_data_ptr:
                const extPointerIndex = bytes.length;
                bytes.push(0, 0, 0, 0);

                // update val_length:
                bytes.data[valLengthIndex] = FLAGS.ENTRY_HAS_EXT_DATA;

                // add the data
                if (hasExtData && !info.extData.rebuild) {
                    // adding ext_data_block to existing leaf is impossible here, 
                    // because we don't have existing ext_data 
                    // addExtData function must be supplied to handle writing
                    console.assert(typeof options.addExtData === 'function', 'to add ext_data to existing leaf, provide addExtData function to options');
                    let { extIndex } = options.addExtData(extPointerIndex, valueBytes.data);
                    bytes.writeUint32(extIndex, extPointerIndex);
                }
                else {
                    // add to in-memory block, leaf output will include ext_data
                    moreDataBlocks.push({ 
                        pointerIndex: extPointerIndex, 
                        bytes: valueBytes
                    });                    
                }
            }
            else {
                // update val_length:
                const valLength = valueBytes.length + (this.uniqueKeys ? 0 : 4); // +4 to include value_list_length bytes //bytes.length - valLengthIndex - 4;
                if (this.smallLeafs) {
                    bytes.data[valLengthIndex] = valLength;
                }
                else {
                    bytes.writeUint32(valLength, valLengthIndex); // _writeByteLength(bytes, valLengthIndex, valLength);
                }

                if (!this.uniqueKeys) {
                    // value_list_length:
                    bytes.writeUint32(entry.values.length); // _writeByteLength(bytes, bytes.length, entry.values.length);
                }

                // add value bytes:
                bytes.append(valueBytes); // _appendToArray(bytes, valueBytes);
            }
        });

        if (moreDataBlocks.length > 0) {
            // additional ext_data block will be written

            if (!hasExtData && typeof options.maxLength === 'number' && options.maxLength > 0) {
                // Try if ext_data_block can be added to the leaf by shrinking the leaf size 
                // (using its free space for ext_data block)
                const minExtDataLength = options.addFreeSpace
                    ? Math.ceil(moreDataBlocks.reduce((length, block) => length + 8 + Math.ceil(block.bytes.length * 1.1), 0) * 1.1)
                    : moreDataBlocks.reduce((length, block) => length + 8 + block.bytes.length, 0);

                const freeBytes = options.maxLength - bytes.length;
                if (freeBytes < minExtDataLength) {
                    throw new DetailedError('leaf-too-small-for-extdata', `leaf needs rebuild: not enough free space to extend leaf with ext_data`);
                }
                // Move free space to ext_data:
                options.maxLength -= minExtDataLength;
                info.extData = {
                    length: minExtDataLength
                };
            }

            hasExtData = true;
            // update leaf_flags:
            bytes.data[leafFlagsIndex] |= FLAGS.LEAF_HAS_EXT_DATA;
        }
        if (!hasExtData) {
            // update leaf_flags: 
            bytes.data[leafFlagsIndex] &= ~FLAGS.LEAF_HAS_EXT_DATA; // if ((bytes[leafFlagsIndex] & FLAGS.LEAF_HAS_EXT_DATA) > 0) { bytes[leafFlagsIndex] ^= FLAGS.LEAF_HAS_EXT_DATA }; // has_ext_data (no)            
            // remove ext_byte_length, ext_free_byte_length
            bytes.splice(extDataHeaderIndex, 8);
        }

        let byteLength = bytes.length;
        if (options.maxLength > 0 && byteLength > options.maxLength) {
            throw new DetailedError('max-leaf-size-reached', `leaf byte size grew above maximum of ${options.maxLength}`);
        }

        let freeSpace = 0;
        if (options.addFreeSpace) {
            if (options.maxLength > 0) {
                freeSpace = options.maxLength - byteLength;
                byteLength = options.maxLength;
            }
            else {
                let freeEntries = this.maxEntriesPerNode - info.entries.length;
                let avgEntrySize = info.entries.length === 0 ? 1 : Math.ceil((byteLength - 18) / info.entries.length);
                // freeSpace = (freeEntries * avgEntrySize) + (avgEntrySize * 2);
                freeSpace = Math.ceil(freeEntries * avgEntrySize * 1.1) // + 10%
                byteLength += freeSpace;
            }

            // Add free space zero bytes
            bytes.append(new Uint8Array(freeSpace)); // Uint8Array is initialized with 0's
            // for (let i = 0; i < freeSpace; i++) {
            //     bytes.push(0);
            // }

            // update free_byte_length:
            bytes.writeUint32(freeSpace, 5); // _writeByteLength(bytes, 5, freeSpace);
        }

        // update byte_length:
        bytes.writeUint32(byteLength, 0); // _writeByteLength(bytes, 0, byteLength);

        // Now, add any ext_data blocks
        if (moreDataBlocks.length > 0) {
            // Can only happen when this is a new leaf, or when it's being rebuilt

            const fbm = options.addFreeSpace ? 0.1 : 0; // fmb -> free bytes multiplier
            // const estimatedExtDataSize = {
            //     data: moreDataBlocks.reduce((total, block) => total + 8 + block.bytes.length + Math.ceil(block.bytes.length * fbm), 0),
            //     get free() { return Math.ceil(this.data * fbm); },
            //     get total() { return this.data + this.free; }
            // };
            const maxEntries = this.maxEntriesPerNode;
            const extDataSize = {
                // minimum size: all ext_data blocks with 10% free space
                minimum: moreDataBlocks.reduce((total, block) => total + 8 + block.bytes.length + Math.ceil(block.bytes.length * fbm), 0),
                // average size: minimum + 10% free bytes for growth
                get average() { return Math.ceil(this.minimum * (1 + fbm)); },
                // ideal size: minimum size + room for more entries percentagewise
                get ideal() {
                    let avgExtBlockSize = Math.ceil(this.minimum / moreDataBlocks.length);
                    let extDataValueRatio = moreDataBlocks.length / leaf.entries.length;
                    // if 5 out of 200 entries have extData: ratio === 0.025 (2.5%)
                    // with total current extData size of 800 bytes, that means it should
                    // allow growth for another 2.5% of remaining entries. With a max of
                    // 255 entries, that means leaving room for 2.5% of 55 more entries.
                    // So, max_entries * ratio * avg_block_size gives us that number!
                    let idealSize = Math.ceil(maxEntries * extDataValueRatio) * avgExtBlockSize;
                    return idealSize;
                },
                used: 0
            }
            extDataSize.used = info.extData
                ? info.extData.length
                : extDataSize.ideal; // default

            if (info.extData && info.extData.length < extDataSize.minimum) { //  && info.extData.rebuild
                // ext_data becomes too large
                // Try to steal free bytes from leaf
                let bytesShort = extDataSize.ideal - info.extData.length; // first try getting space for free ext_data bytes as well
                extDataSize.used = extDataSize.ideal;
                if (freeSpace < bytesShort) {
                    // Not enough free space for the ideal size. Try again with only 10% free bytes
                    bytesShort = extDataSize.average - info.extData.length;
                    extDataSize.used = extDataSize.average;
                }
                if (freeSpace < bytesShort) {
                    // Not enough free space to include ext_data free bytes. Try again without ext_data free bytes
                    bytesShort = extDataSize.minimum - info.extData.length;
                    extDataSize.used = extDataSize.minimum;
                }
                if (freeSpace >= bytesShort) {
                    // steal free bytes from leaf
                    byteLength -= bytesShort;
                    freeSpace -= bytesShort;

                    // update byte_length:
                    bytes.writeUint32(byteLength, 0);

                    // update free_byte_length:
                    bytes.writeUint32(freeSpace, 5);                    

                    // remove trailing free bytes from leaf buffer:
                    bytes.splice(bytes.length - bytesShort);

                    // Add bytes to ext_data
                    info.extData.length += bytesShort;
                }
                else {
                    throw new DetailedError('max-leaf-extdata-size-reached', `leaf extdata grows larger than the ${info.extData.length} bytes available to it`);
                }
            }

            const leafEndIndex = bytes.length;
            bytes.reserve(extDataSize.used);

            while (moreDataBlocks.length > 0) { // moreDataBlocks.forEach(block => {
                const block = moreDataBlocks.shift();
                const offset = bytes.length - leafEndIndex; // offset from leaf end index
                bytes.writeUint32(offset, block.pointerIndex); // _writeByteLength(bytes, block.pointerIndex, offset); // update ext_data_ptr
                
                // Calculate 10% free space per block
                const free = options.addFreeSpace ? Math.ceil(block.bytes.length * 0.1) : 0;
                const blockLength = block.bytes.length + free;

                // ext_block_length:
                bytes.writeUint32(blockLength); // _writeByteLength(bytes, bytes.length, blockLength);

                // ext_block_free_length:
                bytes.writeUint32(free); // _writeByteLength(bytes, bytes.length, free);

                // data:
                bytes.append(block.bytes.data); // _appendToArray(bytes, block.bytes);

                // Add free space:
                // for (let i = 0; i < free; i++) { bytes.push(0); }
                bytes.append(new Uint8Array(free)); // Uin8Array is initialized with 0's
            } //);

            const extByteLength = bytes.length - leafEndIndex;
            console.assert(extByteLength === extDataSize.minimum, 'These must be equal by now!');

            // if (info.extData && info.extData.rebuild && info.extData.length < extByteLength) {
            //     // ext_data became too large
            //     // Try to steal free bytes from leaf
            //     const bytesShort = extByteLength - info.extData.length;
            //     if (freeSpace >= bytesShort) {
            //         // steal free bytes from leaf
            //         freeSpace -= bytesShort;
            //         leafEndIndex -= bytesShort;

            //         // Add bytes to ext_data
            //         info.extData.length = extByteLength; //+= bytesShort;

            //         // remove trailing free bytes from leaf buffer:
            //         bytes.splice(leafEndIndex);

            //         // update free_byte_length:
            //         bytes.writeUint32(freeSpace, 5);                    
            //     }
            //     else {
            //         throw new Error(`leaf ext_data grew larger than the ${info.extData.length} bytes available to it`);
            //     }
            // }
            const extFreeByteLength = info.extData // && info.extData.rebuild
                ? info.extData.length - extByteLength
                : options.addFreeSpace 
                    ? extDataSize.used - extByteLength //  Math.ceil(extByteLength * 0.1) 
                    : 0;

            // update extData info
            hasExtData = true;
            if (info.extData) {
                info.extData.freeBytes = extFreeByteLength;
            }
            else {
                info.extData = {
                    length: extByteLength + extFreeByteLength,
                    freeBytes: extFreeByteLength
                }
            }

            // Add free space:
            // for (let i = 0; i < extFreeByteLength; i++) { bytes.push(0); }
            bytes.append(new Uint8Array(extFreeByteLength)); // Uin8Array is initialized with 0's

            // adjust byteLength
            byteLength = bytes.length;
        }
        else if (hasExtData) {
            byteLength += info.extData.length;
        }

        if (hasExtData) {
            // update leaf_flags:
            bytes.data[leafFlagsIndex] |= FLAGS.LEAF_HAS_EXT_DATA; // has_ext_data (yes)
            // update ext_byte_length:
            bytes.writeUint32(info.extData.length, extDataHeaderIndex); // _writeByteLength(bytes, extDataHeaderIndex, info.extData.length);
            // update ext_free_byte_length:
            bytes.writeUint32(info.extData.freeBytes, extDataHeaderIndex + 4); // _writeByteLength(bytes, extDataHeaderIndex + 4, info.extData.freeBytes);
        }

        if (info.nextIndex === 'adjacent') {
            // update next_leaf_ptr
            nextLeafOffset = byteLength - 15;
            bytes.writeInt48(nextLeafOffset, 15); //_writeSignedOffset(bytes, 15, nextLeafOffset, true);
        }

        // console.log(`Created leaf, ${bytes.length} bytes generated`);
        return bytes.data;
    }

    getLeafEntryValueBytes(recordPointer, metadata) {
        const bytes = [];

        // value_length:
        bytes.push(recordPointer.length);

        // value_data:
        bytes.push(...recordPointer);

        // metadata:
        this.metadataKeys.forEach(key => {
            const metadataValue = metadata[key];
            const valueBytes = BPlusTree.getBinaryKeyData(metadataValue); // metadata_value has same structure as key, so getBinaryKeyData comes in handy here
            bytes.push(...valueBytes);
        });

        return bytes;
    }

    static getKeyBytes(key) {
        let keyBytes = [];
        let keyType = KEY_TYPE.UNDEFINED;
        switch(typeof key) {
            case "undefined": {
                keyType = KEY_TYPE.UNDEFINED;
                break;
            }                
            case "string": {
                keyType = KEY_TYPE.STRING;
                keyBytes = Array.from(encodeString(key)); // textEncoder.encode(key)
                console.assert(keyBytes.length < 256, `key byte size for "${key}" is too large, max is 255`);
                break;
            }
            case "number": {
                keyType = KEY_TYPE.NUMBER;
                keyBytes = numberToBytes(key);
                // Remove trailing 0's to reduce size for smaller and integer values
                while (keyBytes[keyBytes.length-1] === 0) { keyBytes.pop(); }
                break;
            }
            case "boolean": {
                keyType = KEY_TYPE.BOOLEAN;
                keyBytes = [key ? 1 : 0];
                break;
            }
            case "object": {
                if (key instanceof Date) {
                    keyType = KEY_TYPE.DATE;
                    keyBytes = numberToBytes(key.getTime());
                }
                else if (key === null) {
                    keyType = KEY_TYPE.UNDEFINED;
                }
                else {
                    throw new DetailedError('invalid-object-key-type', `Unsupported object key type: ${key}`);
                }
                break;
            }
            default: {
                throw new DetailedError('invalid-key-type', `Unsupported key type: ${typeof key}`);
            }
        }

        const bytes = [];

        // key_type:
        bytes.push(keyType);

        // key_length:
        bytes.push(keyBytes.length);

        // key_data:
        bytes.push(...keyBytes);

        return bytes;
    }    
}

class BinaryReader {
    /**
     * BinaryReader is a helper class to make reading binary data easier and faster
     * @param {string|number|(index: number, length: number) => Promise<Buffer>|number} file file name, file descriptor, or an open file, or read function that returns a promise
     * @param {number} [chunkSize=4096] how many bytes per read. default is 4KB
     */
    constructor(file, chunkSize = 4096) {
        this.chunkSize = chunkSize;

        if (typeof file === 'function') {
            // Use the passed function for reads
            this.read = file;
        }
        else {
            let fd;
            if (typeof file === 'number') {
                // Use the passed file descriptor
                fd = file;
            }
            else if (typeof file === 'string') {
                // Read from passed file name 
                // Override this.init to open the file first
                let init = this.init.bind(this);
                this.init = () => {
                    return new Promise((resolve, reject) => {
                        // Open file now
                        fs.open(file, 'r', (err, fileDescriptor) => {
                            if (err) { return reject(err); }
                            fd = fileDescriptor;
                            // Run original this.init
                            init().then(resolve).catch(reject);
                        });
                    });
                };
                this.close = () => {
                    return new Promise((resolve, reject) => {
                        fs.close(fd, err => {
                            if (err) { reject(err); }
                            else { resolve(); }
                        });
                    });
                }
            }
            else {
                throw new DetailedError('invalid-file-argument', 'invalid file argument');
            }

            this.read = (index, length) => {
                return new Promise((resolve, reject) => {
                    const buffer = Buffer.alloc(length); // new Uint8Array(length); // new Buffer(length);
                    fs.read(fd, buffer, 0, length, index, (err, bytesRead) => {
                        if (err) { return reject(err); }
                        else if (bytesRead < length) { resolve(buffer.slice(0, bytesRead)); }
                        else { resolve(buffer); }
                    });
                });
            };
        }

        /** @type {Buffer} */
        this.data = null;
        this.offset = 0;    // offset of loaded data (start index of current chunk in data source)
        this.index = 0;     // current chunk reading index ("cursor" in currently loaded chunk)
    }
    /**
     * @returns {Promise<void>} 
     */
    init() {
        return this.read(0, this.chunkSize)
        .then(chunk => {
            console.assert(chunk instanceof Buffer, 'read function must return a Buffer');
            this.data = chunk;
            this.offset = 0;
            this.index = 0;
        });
    }
    clone() {
        const clone = Object.assign(new BinaryReader(this.read, this.chunkSize), this);
        clone.offset = 0;
        clone.index = 0;
        clone.data = Buffer.alloc(0);
        return clone;
    }
    /**
     * 
     * @param {number} byteCount 
     * @returns {Promise<Buffer>}
     */
    get(byteCount) {
        return this.assert(byteCount)
        .then(() => {
            // const bytes = this.data.slice(this.index, this.index + byteCount);
            let slice = this.data.slice(this.index, this.index + byteCount); // Buffer.from(this.data.buffer, this.index, byteCount);
            console.assert(slice.byteLength === byteCount);
            this.index += byteCount;
            return slice;
        });
    }
    getInt32() {
        return this.get(4)
        .then(buffer => {
            return _readSignedNumber(buffer, 0);
        });
    }
    getUint32() {
        return this.get(4)
        .then(buffer => {
            return _readByteLength(buffer, 0);
        });
    }
    getValue() {
        return this.get(2)
        .then(b => {
            let bytes = Array.from(b);
            return this.get(bytes[1])
            .then(b => {
                _appendToArray(bytes, Array.from(b));
                return BinaryReader.readValue(Buffer.from(bytes), 0).value;
            });
        });
    }
    more(chunks = 1) {
        const length = chunks * this.chunkSize;
        return this.read(this.offset + this.data.length, length)
        .then(nextChunk => {
            console.assert(nextChunk instanceof Buffer, 'read function must return a Buffer');

            // Let go of old data before current index:
            this.data = this.data.slice(this.index);
            this.offset += this.index;
            this.index = 0;

            // Append new data
            const newData = Buffer.alloc(this.data.length + nextChunk.length);
            newData.set(this.data, 0);
            newData.set(nextChunk, this.data.length);
            this.data = newData;
        });
    }
    seek(offset) {
        if (this.index + offset < this.data.length) {
            this.index += offset;
            return Promise.resolve();
        }
        let dataIndex = this.offset + this.index + offset;
        return this.read(dataIndex, this.chunkSize)
        .then(newChunk => {
            this.data = newChunk;
            this.offset = dataIndex;
            this.index = 0;
        });        
    }
    assert(byteCount) {
        console.assert(byteCount >= 0, `Invalid byteCount: ${byteCount}`);
        if (this.index + byteCount > this.data.byteLength) {
            return this.more(Math.ceil(byteCount / this.chunkSize))
            .then(() => {
                if (this.index + byteCount > this.data.byteLength) {
                    throw new DetailedError('EOF', 'end of file');
                }
            });
        }
        else {
            return Promise.resolve();
        }        
    }
    skip(byteCount) {
        this.index += byteCount;
    }
    rewind(byteCount) {
        this.index -= byteCount;
    }
    /**
     * 
     * @param {number} index 
     * @returns {Promise<void>}
     */
    go(index) {
        if (this.offset <= index && this.offset + this.data.byteLength > index) {
            this.index = index - this.offset;
            return Promise.resolve();
        }
        return this.read(index, this.chunkSize)
        .then(chunk => {
            this.data = chunk;
            this.offset = index;
            this.index = 0;
        });
    }
    savePosition(offsetCorrection = 0) {
        let savedIndex = this.offset + this.index + offsetCorrection;
        let go = (offset = 0) => {
            let index = savedIndex + offset;
            return this.go(index);
        }
        return {
            go,
            index: savedIndex
        };
    }
    get sourceIndex() {
        return this.offset + this.index;
    }

    static readValue(buffer, index) {
        const val = BPlusTree.getKeyFromBinary(buffer, index);
        return { value: val.key, byteLength: val.byteLength };
    }
    static bytesToNumber(buffer) {
        return bytesToNumber(buffer);
    }
    static readUint32(buffer, index) {
        return _readSignedNumber(buffer, index);
    }
    static readInt32(buffer, index) {
        return _readByteLength(buffer, index, signedNumber);
    }    
}

class TX {
    constructor() {
        this._queue = [];
        this._rollbackSteps = [];
    }
    // For sequential transactions:
    run(action, rollback) {
        console.assert(this._queue.length === 0, 'queue must be empty');
        typeof rollback === 'function' && this._rollbackSteps.push(rollback);
        let p = action instanceof Promise ? action : action();
        return p.catch(err => {
            console.error(`TX.run error: ${err.message}. Initiating rollback`)
            // rollback
            let steps = this._rollbackSteps.map(step => step());
            return Promise.all(steps)
            .then(() => {
                // rollback successful
                throw err; // run().catch will fire with the original error
            })
            .catch(err2 => {
                // rollback failed!!
                console.error(`Critical: could not rollback changes. Error: ${err2.message}`)
                err.rollbackError = err2;
                throw err;
            });
        })
    }
    // For parallel transactions:
    queue(step = { name: null, action: () => {}, rollback: () => {} }) {
        this._queue.push({ 
            name: step.name || `Step ${this._queue.length+1}`, 
            action: step.action, rollback: 
            step.rollback, 
            state: 'idle', 
            error: null 
        });
    }
    execute(parallel = true) {
        if (!parallel) {
            // Sequentially run actions in queue
            let rollbackSteps = [];
            const next = (prevResult) => {
                let step = this._queue.shift();
                if (!step) { 
                    // Done
                    return prevResult; 
                }
                rollbackSteps.push(step.rollback);
                return step.action(prevResult)
                .then(result => {
                    return next(result);
                })
                .catch(err => {
                    // rollback
                    let actions = rollbackSteps.map(step => step());
                    return Promise.all(actions)
                    .then(() => {
                        // rollback successful
                        throw err; // execute().catch will fire with the original error
                    })
                    .catch(err2 => {
                        // rollback failed!!
                        console.error(`Critical: could not rollback changes. Error: ${err2.message}`)
                        err.rollbackError = err2;
                        throw err;
                    });
                });
            }
            const runSteps = next;
            return runSteps();
        }

        // Run actions in parallel:
        const executeStepAction = (step, action) => {
            return Promise.try(() => {
                const promise = step[action]();
                if (!(promise instanceof Promise)) {
                    throw new DetailedError('invalid-tx-step-code', `step "${step.name}" action "${action}" must return a promise`);
                }
                return promise;
            })
            .then(result => {
                step.state = 'success';
                step.result = result;
                return step;
            })
            .catch(err => {
                step.state = 'failed';
                step.error = err;
                return step;
            });
        };
        let actions = this._queue.map(step => executeStepAction(step, 'action'));
        return Promise.all(actions)
        .then(results => {
            // Check if they were all successful
            const success = results.every(step => step.state === 'success');
            if (success) { return; }

            // Rollback
            const transactionErrors = results.filter(step => step.state === 'failed').map(result => result.error);
            // console.warn(`Rolling back tx: `, transactionErrors);
            let rollbackSteps = this._queue.filter(step => typeof step.rollback === 'function').map(step => executeStepAction(step, 'rollback')); // this._queue.map(step => step.state === 'failed' || typeof step.rollback !== 'function' ? null : step.rollback());
            return Promise.all(rollbackSteps)
            .then(results => {
                // Check if rollback was successful
                const success = results.every(step => step.state === 'success');
                if (success) { 
                    const err = new DetailedError('tx-failed', `Tx failed, rolled back. See transactionErrors property for details`);
                    err.transactionErrors = transactionErrors;
                    throw err;
                }

                // rollback failed!!
                const err = new DetailedError('tx-rollback-failed', `Critical: could not rollback failed transaction. See transactionErrors and rollbackErrors for details`);
                err.transactionErrors = transactionErrors;
                err.rollbackErrors = results.filter(step => step.state === 'failed').map(result => result.error);
                
                console.error(`Critical: could not rollback transaction. Errors:`, err.rollbackErrors)
                throw err;
            });
        });
    }
}

class Uint8ArrayBuilder {
    static get blockSize() { 
        return 4096; 
    }
    constructor(bytes = null) {
        /** @type {Uint8Array} */
        this._data = new Uint8Array();
        this._length = 0;
        bytes && this.append(bytes);
    }
    reserve(byteCount) {
        const addBytes = Uint8ArrayBuilder.blockSize * Math.ceil(byteCount / Uint8ArrayBuilder.blockSize);
        const newLength = this._data.byteLength + addBytes;
        // this._data = new Uint8Array(this._data.buffer, 0, newLength);
        const newData = new Uint8Array(newLength);
        newData.set(this._data, 0);
        this._data = newData;
    }
    append(bytes) {
        if (bytes instanceof Uint8ArrayBuilder) {
            bytes = bytes.data;
        }
        const freeBytes = this._data.byteLength - this._length;
        if (freeBytes < bytes.length) {
            // Won't fit
            const bytesShort = bytes.length - freeBytes;
            const addBytes = Uint8ArrayBuilder.blockSize * Math.ceil((bytesShort * 1.1) / Uint8ArrayBuilder.blockSize);
            const newLength = this._data.byteLength + addBytes;
            // this._data = new Uint8Array(this._data.buffer, 0, newLength);
            const newData = new Uint8Array(newLength);
            newData.set(this._data, 0);
            this._data = newData;
        }
        // Add bytes
        this._data.set(bytes, this._length);
        this._length += bytes.length;
        return this;        
    }
    push(...bytes) {
        if (bytes.length === 0) {
            console.warn('WARNING: pushing 0 bytes to Uint8ArrayBuilder!');
        }
        return this.append(bytes);
    }
    writeUint32(positiveNumber, index = undefined) {
        let bytes = _writeByteLength([], 0, positiveNumber);
        if (index >= 0) {
            this._data.set(bytes, index);
            return this;
        }
        return this.append(bytes);
    }
    writeInt32(signedNumber, index = undefined) {
        let bytes = _writeSignedNumber([], 0, signedNumber);
        if (index >= 0) {
            this._data.set(bytes, index);
            return this;
        }
        return this.append(bytes);
    }
    writeInt48(signedNumber, index = undefined) {
        let bytes = _writeSignedOffset([], 0, signedNumber, true);
        if (index >= 0) {
            this._data.set(bytes, index);
            return this;
        }
        return this.append(bytes);
    }
    /** @type {Uint8Array} */
    get data() {
        return this._data.subarray(0, this._length);
    }
    get length() {
        return this._length;
    }
    slice(begin, end) {
        if (begin < 0) { 
            return this._data.subarray(this._length + begin, this._length); 
        }
        else { 
            return this._data.subarray(begin, end || this._length);
        }
    }
    splice(index, remove) {
        if (typeof remove !== 'number') { 
            remove = this.length - index; 
        }
        let removed = this._data.slice(index, index + remove);
        if (index + remove >= this.length) {
            this._length = index;
        }
        else {
            this._data.copyWithin(index, index + remove, this._length);
            this._length -= remove;
        }
        return removed;
    }
}

module.exports = { 
    BPlusTree,
    BinaryBPlusTree,
    BinaryBPlusTreeLeafEntry,
    BPlusTreeBuilder,
    BinaryWriter,
    BinaryReader,
    BlacklistingSearchOperator
};