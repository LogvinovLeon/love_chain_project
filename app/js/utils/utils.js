const utils = {
    keyWords(words) {
        const keywords = {};
        for (const word of words) {
            keywords[word] = word;
        }
        return keywords;
    },
};

export default utils;