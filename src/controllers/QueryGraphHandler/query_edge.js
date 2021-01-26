const helper = require("./helper");

module.exports = class QEdge {
    /**
     * 
     * @param {string} id - QEdge ID
     * @param {object} info - QEdge info, e.g. subject, object, predicate
     */
    constructor(id, info) {
        this.id = id;
        this.predicate = info.predicate;
        this.subject = info.subject;
        this.object = info.object;
    }

    getID() {
        return this.id;
    }

    setID(id) {
        this.id = id;
    }

    getHashedEdgeRepresentation() {
        const toBeHashed = this.subject.getCategory() + this.predicate + this.object.getCategory() + this.getInputCurie();
        return new helper()._generateHash(toBeHashed);
    }

    getPredicate() {
        if (this.predicate && this.predicate.startsWith("biolink:")) {
            return this.predicate.slice(8);
        }
        return this.predicate;
    }

    getSubject() {
        if (this.isReversed()) {
            return this.object;
        }
        return this.subject;
    }

    getObject() {
        if (this.isReversed()) {
            return this.subject;
        }
        return this.object;
    }

    isReversed() {
        return this.subject.getCurie() === undefined && this.object.getCurie() !== undefined;
    }

    getInputCurie() {
        let curie = this.subject.getCurie() || this.object.getCurie();
        if (Array.isArray(curie)) {
            return curie;
        }
        return [curie];
    }

    getInputNode() {
        return ((this.isReversed()) ? this.object : this.subject);
    }

    getOutputNode() {
        return ((this.isReversed()) ? this.subject : this.object);
    }

    hasInputResolved() {
        if (this.isReversed()) {
            return this.object.hasEquivalentIDs();
        }
        return this.subject.hasEquivalentIDs();
    }

    hasInput() {
        if (this.isReversed()) {
            return this.object.hasInput();
        }
        return this.subject.hasInput();
    }
}