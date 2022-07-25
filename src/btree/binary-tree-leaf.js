"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinaryBPlusTreeLeaf = void 0;
const detailed_error_1 = require("../detailed-error");
const binary_tree_node_info_1 = require("./binary-tree-node-info");
const typesafe_compare_1 = require("./typesafe-compare");
class BinaryBPlusTreeLeaf extends binary_tree_node_info_1.BinaryBPlusTreeNodeInfo {
    constructor(nodeInfo) {
        console.assert(typeof nodeInfo.hasExtData === 'boolean', 'nodeInfo.hasExtData must be specified');
        super(nodeInfo);
        this.prevLeafOffset = 0;
        this.nextLeafOffset = 0;
        this.extData = {
            length: 0,
            freeBytes: 0,
            loaded: false,
            async load() {
                // Make sure all extData blocks are read. Needed when eg rebuilding
                throw new detailed_error_1.DetailedError('method-not-overridden', 'BinaryBPlusTreeLeaf.extData.load must be overriden');
            },
        };
        this.entries = [];
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
    get hasPrevious() { return typeof this.getPrevious === 'function'; }
    get hasNext() { return typeof this.getNext === 'function'; }
    get prevLeafIndex() {
        return this.prevLeafOffset !== 0
            ? this.index + 9 + this.prevLeafOffset
            : 0;
    }
    set prevLeafIndex(newIndex) {
        this.prevLeafOffset = newIndex > 0
            ? newIndex - this.index - 9
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
        return this.entries.findIndex(entry => (0, typesafe_compare_1._isEqual)(entry.key, key));
    }
    findEntry(key) {
        return this.entries[this.findEntryIndex(key)];
    }
}
exports.BinaryBPlusTreeLeaf = BinaryBPlusTreeLeaf;
//# sourceMappingURL=binary-tree-leaf.js.map