import { Plugin } from "@elizaos/core";

import { dkgInsert } from "./actions/dkgInsert.ts";
// DISABLED: dkgAnalyzeSentiment uses deprecated Twitter guest tokens
// import { dkgAnalyzeSentiment } from "./actions/dkgAnalyzeSentiment.ts";

import { graphSearch } from "./providers/graphSearch.ts";

// DISABLED: sentimentAnalysisEvaluator triggers dkgAnalyzeSentiment action
// import { sentimentAnalysisEvaluator } from "./evaluators/sentimentAnalysisEvaluator.ts";

export * as actions from "./actions";
export * as providers from "./providers";
export * as evaluators from "./evaluators";

export const dkgPlugin: Plugin = {
    name: "dkg",
    description:
        "Agent DKG which allows you to store memories on the OriginTrail Decentralized Knowledge Graph",
    actions: [dkgInsert], // Removed dkgAnalyzeSentiment (uses guest tokens)
    providers: [graphSearch],
    evaluators: [], // Removed sentimentAnalysisEvaluator
};
