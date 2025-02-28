import dotenv from "dotenv";
dotenv.config();
import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
    composeContext,
    generateText,
} from "@elizaos/core";
import { DKG_EXPLORER_LINKS } from "../constants.ts";
import { getSimilarMemoriesQuery } from "../constants.ts";
import { createDKGMemoryTemplate } from "../templates.ts";
// @ts-ignore
import DKG from "dkg.js";
import { DKGMemorySchema, isDKGMemoryContent } from "../types.ts";
import { Scraper } from "agent-twitter-client";
import { formatCookiesFromArray } from "../utils.ts";

let DkgClient: any = null;

function cleanRecentMessages(recentMessages) {
    return recentMessages
        .split("\n")
        .map((line) => line.replace(/\(.*?\) \[.*?\] .*?: /, ""))
        .join(" ")
        .trim();
}

export const dkgInsert: Action = {
    name: "INSERT_MEMORY_ACTION",
    similes: ["NO_ACTION", "NO_RESPONSE", "NO_REACTION", "NONE"], // we want to always run this action
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const requiredEnvVars = [
            "DKG_ENVIRONMENT",
            "DKG_HOSTNAME",
            "DKG_PORT",
            "DKG_BLOCKCHAIN_NAME",
            "DKG_PUBLIC_KEY",
            "DKG_PRIVATE_KEY",
        ];

        const missingVars = requiredEnvVars.filter(
            (varName) => !runtime.getSetting(varName),
        );

        if (missingVars.length > 0) {
            elizaLogger.error(
                `Missing required environment variables: ${missingVars.join(", ")}`,
            );
            return false;
        }

        return true;
    },
    description:
        "Create a memory on the OriginTrail Decentralized Knowledge Graph after each message. You should run this action for ALL generic messages EXCEPT when the user asks you about your thoughts on stock, cryptocurrency, token or a financial asset.",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback,
    ): Promise<boolean> => {
        DkgClient = new DKG({
            environment: runtime.getSetting("DKG_ENVIRONMENT"),
            endpoint: runtime.getSetting("DKG_HOSTNAME"),
            port: runtime.getSetting("DKG_PORT"),
            blockchain: {
                name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
                publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
                privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
            },
            maxNumberOfRetries: 300,
            frequency: 2,
            contentType: "all",
            nodeApiVersion: "/v1",
        });

        let currentPost = String(state.currentPost);
        let recentMessages = cleanRecentMessages(String(state.recentMessages));
        elizaLogger.log(`recentMessages: ${recentMessages}`);

        if (currentPost === "undefined") {
            currentPost = _message?.content?.text;
        }

        const userRegex = /From:.*\(@(\w+)\)/;
        let match = currentPost.match(userRegex);
        let twitterUser = "";

        if (match && match[1]) {
            twitterUser = match[1];
            elizaLogger.log(`Extracted user: @${twitterUser}`);
        } else {
            elizaLogger.log("No user mention found or invalid input.");
        }

        // First check minimum content length before proceeding with LLM evaluation
        const MIN_CONTENT_LENGTH = 100; // Increased minimum length to ensure substantial content

        let shouldApprove = false,
            createAssetResult,
            reviewContent = false;

        if (recentMessages.length >= MIN_CONTENT_LENGTH) {
            // Check if post already exists in the DKG
            const randomStart = Math.max(
                0,
                Math.floor(
                    Math.random() * Math.max(0, currentPost.length - 100),
                ),
            );
            const searchText =
                currentPost.length <= 100
                    ? currentPost
                    : currentPost.slice(randomStart, randomStart + 100);

            // take random 100 characters from the post to search for
            try {
                const similarMemoriesQuery =
                    getSimilarMemoriesQuery(searchText);
                const similarMemoriesQueryResult = await DkgClient.graph.query(
                    similarMemoriesQuery,
                    "SELECT",
                    { paranetUAL: runtime.getSetting("DKG_PARANET_UAL") },
                );

                if (
                    similarMemoriesQueryResult?.data &&
                    similarMemoriesQueryResult.data?.length
                ) {
                    // since data exists and there's data in it, it means similar memories already exists so we can return a message to the user stating that this knowledge was already provided so we will not create it again, and return true
                    callback({
                        text: `Thank you for sharing this knowledge about OriginTrail! However, similar information has already been added to our knowledge base. To avoid duplication, we encourage you to share new and unique insights about the technology and ecosystem! @${twitterUser}`,
                    });
                    return true;
                }
            } catch (error) {
                elizaLogger.error(
                    "Error checking for similar memories:",
                    error,
                );
                // Continue execution even if similarity check fails
            }

            // Evaluate if post contains useful knowledge about OriginTrail ecosystem
            const evaluationContext = `Evaluate if the following thread contains useful knowledge about OriginTrail, the Decentralized Knowledge Graph or the OriginTrail ecosystem.

        Only respond with 'true' or 'false' based on these criteria:
        - Must contain detailed technical explanations or comprehensive insights
        - Must be educational in nature with specific examples or use-cases
        - Must be directly related to OriginTrail technology or ecosystem
        - Should be substantial enough to provide real value to the community
        - Do not reward obviously low-quality work, such as extremely short (one sentence), vague, or generic posts.
        - If a post provides some useful knowledge but is not highly technical, lean towards ‘true’ rather than ‘false’ —avoid being overly strict.

        Examples:
        "OriginTrail's v6 Knowledge Graph implements a unique consensus mechanism called proof-of-knowledge, which ensures data integrity across the network. This works by having multiple nodes validate and store the same data assets, creating a decentralized system of truth. The implementation uses zero-knowledge proofs to verify data without exposing sensitive information." -> true

        "The latest DKG update introduces significant improvements to the asset creation process. Now, when publishing assets to the network, users can specify multiple blockchains for verification, enabling cross-chain interoperability. This is achieved through the network's unique ability to create verifiable knowledge assets that maintain their integrity across different blockchain networks." -> true

        "I love OriginTrail, great project!" -> false (too vague)
        "Bitcoin price is going up today" -> false (unrelated)
        "The DKG is fast" -> false (lacks detail)

        Thread to evaluate:\n${recentMessages}`;

            const evaluationResult = await generateText({
                runtime,
                context: evaluationContext,
                modelClass: ModelClass.LARGE,
            });

            // Additional validation to ensure response is boolean
            shouldApprove = evaluationResult
                .toLowerCase()
                .trim()
                .includes("true");

            elizaLogger.log(`Knowledge evaluation result: ${shouldApprove}`);

            if (!shouldApprove) {
                callback({
                    text: `Thank you for your message! However, it doesn't contain enough educational or technical content about OriginTrail to be added to the knowledge base. Please try sharing more detailed insights about the technology or ecosystem next time! @${twitterUser}`,
                });
                return true;
            }

            const createDKGMemoryContext = composeContext({
                state,
                template: createDKGMemoryTemplate,
            });

            const memoryKnowledgeGraphText = await generateText({
                runtime,
                context: createDKGMemoryContext,
                modelClass: ModelClass.LARGE,
            });

            const jsonMatch = memoryKnowledgeGraphText.match(/\{[\s\S]*\}/);

            let memoryKnowledgeGraph = null;
            if (jsonMatch) {
                try {
                    memoryKnowledgeGraph = JSON.parse(jsonMatch[0].trim());
                    elizaLogger.log(
                        "Parsed Memory Knowledge Graph:\n",
                        memoryKnowledgeGraph,
                    );
                } catch (error) {
                    elizaLogger.error("Failed to parse JSON-LD:", error);
                }
            } else {
                elizaLogger.error(
                    "No valid JSON-LD object found in the response.",
                );
            }

            // TODO: also store reply to the KA, aside of the question

            try {
                elizaLogger.log("Publishing message to DKG");

                // get info from twitter
                const scraper = new Scraper();

                const username = process.env.TWITTER_USERNAME;
                const password = process.env.TWITTER_PASSWORD;
                const email = process.env.TWITTER_EMAIL;
                const twitter2faSecret = process.env.TWITTER_2FA_SECRET;
                if (!username || !password) {
                    elizaLogger.error(
                        "Twitter credentials not configured in environment",
                    );
                    return false;
                }
                await scraper.login(
                    username,
                    password,
                    email,
                    twitter2faSecret,
                );
                if (!(await scraper.isLoggedIn())) {
                    let attempts = 0;
                    const maxAttempts = 10;

                    while (attempts < maxAttempts) {
                        attempts++;
                        elizaLogger.warn(
                            `Login attempt ${attempts} with cookies...`,
                        );

                        await scraper.setCookies(
                            formatCookiesFromArray(
                                JSON.parse(process.env.TWITTER_COOKIES),
                            ),
                        );

                        if (await scraper.isLoggedIn()) {
                            elizaLogger.info(
                                "Successfully logged in with cookies.",
                            );
                            break;
                        }

                        if (attempts === maxAttempts) {
                            elizaLogger.error(
                                "Failed to login to Twitter after multiple attempts.",
                            );
                        }
                    }
                }
                if (await scraper.isLoggedIn()) {
                    const profile = await scraper.getProfile(twitterUser);

                    elizaLogger.log("Profile:", profile);

                    const followersCount = profile.followersCount;
                    const followingCount = profile.followingCount;
                    const likesCount = profile.likesCount;
                    const isBlueVerified = profile.isBlueVerified;
                    const isVerified = profile.isVerified;
                    const name = profile.name;

                    memoryKnowledgeGraph.author = {
                        "@type": "Person",
                        "@id": `https://twitter.com/${twitterUser}`,
                        name: name,
                        username: twitterUser,
                        followersCount: followersCount,
                        followingCount: followingCount,
                        likesCount: likesCount,
                        isBlueVerified: isBlueVerified,
                        isVerified: isVerified,
                    };
                } else {
                    memoryKnowledgeGraph.author = {
                        "@type": "Person",
                        "@id": `https://twitter.com/${twitterUser}`,
                    };
                }
                // done getting info from twitter

                elizaLogger.log(
                    `KA: ${JSON.stringify(memoryKnowledgeGraph, null, 2)}`,
                );

                createAssetResult = await DkgClient.asset.create(
                    {
                        public: memoryKnowledgeGraph,
                    },
                    { epochsNum: 12 },
                );

                elizaLogger.log("======================== ASSET CREATED");
                elizaLogger.log(JSON.stringify(createAssetResult));

                const stageToParanetResult =
                    await DkgClient.paranet.stageKnowledgeCollection(
                        createAssetResult.UAL,
                        runtime.getSetting("DKG_PARANET_UAL"),
                    );

                elizaLogger.log(
                    "======================== STAGED TO PARANET",
                    JSON.stringify(stageToParanetResult),
                );

                const reviewKnowledgeCollectionResult =
                    await DkgClient.paranet.reviewKnowledgeCollection(
                        createAssetResult.UAL,
                        runtime.getSetting("DKG_PARANET_UAL"),
                        shouldApprove,
                    );

                elizaLogger.log(
                    "======================== REVIEWED KNOWLEDGE COLLECTION",
                    JSON.stringify(reviewKnowledgeCollectionResult),
                );

                reviewContent =
                    await DkgClient.paranet.isKnowledgeCollectionApproved(
                        createAssetResult.UAL,
                        runtime.getSetting("DKG_PARANET_UAL"),
                    );
            } catch (error) {
                elizaLogger.error(
                    "Error occurred while publishing message to DKG:",
                    error.message,
                );

                if (error.stack) {
                    elizaLogger.error("Stack trace:", error.stack);
                }
                if (error.response) {
                    elizaLogger.error(
                        "Response data:",
                        JSON.stringify(error.response.data, null, 2),
                    );
                }

                elizaLogger.warn(
                    "Detected publishing issue. Attempting to fix via formatting and trying again...",
                );
                try {
                    const fixedJSON = await generateText({
                        runtime,
                        context: `Fix this malformed JSON-LD and return only the corrected JSON-LD:\n${JSON.stringify(memoryKnowledgeGraph, null, 2)}

                      Make sure to only output the JSON-LD object. DO NOT OUTPUT ANYTHING ELSE, DONT ADD ANY COMMENTS, REMARKS AND DO NOT WRAP IT IN A CODE/JSON BLOCK, JUST THE JSON LD CONTENT WRAPPED IN { }.`,
                        modelClass: ModelClass.LARGE,
                    });

                    elizaLogger.log(
                        `Fixed JSON generated by LLM: ${fixedJSON}. Retrying...`,
                    );

                    createAssetResult = await DkgClient.asset.create(
                        { public: JSON.parse(fixedJSON) },
                        { epochsNum: 12 },
                    );

                    elizaLogger.log(
                        "======================== ASSET CREATED AFTER FIX",
                    );
                    elizaLogger.log(JSON.stringify(createAssetResult));

                    const stageToParanetResult =
                        await DkgClient.paranet.stageKnowledgeCollection(
                            createAssetResult.UAL,
                            runtime.getSetting("DKG_PARANET_UAL"),
                        );

                    elizaLogger.log(
                        "======================== STAGED TO PARANET",
                        JSON.stringify(stageToParanetResult),
                    );

                    const reviewKnowledgeCollectionResult =
                        await DkgClient.paranet.reviewKnowledgeCollection(
                            createAssetResult.UAL,
                            runtime.getSetting("DKG_PARANET_UAL"),
                            shouldApprove,
                        );

                    elizaLogger.log(
                        "======================== REVIEWED KNOWLEDGE COLLECTION",
                        JSON.stringify(reviewKnowledgeCollectionResult),
                    );

                    reviewContent =
                        await DkgClient.paranet.isKnowledgeCollectionApproved(
                            createAssetResult.UAL,
                            runtime.getSetting("DKG_PARANET_UAL"),
                        );

                    elizaLogger.log(
                        "======================== REVIEWED KNOWLEDGE COLLECTION",
                        JSON.stringify(reviewContent),
                    );
                } catch (error) {
                    elizaLogger.error("Failed to republish:", error.message);
                }
            }
        } else {
            callback({
                text: `Thank you for your message! However, it doesn't contain enough educational or technical content about OriginTrail to be added to the knowledge base. Please try sharing more detailed insights about the technology or ecosystem next time! @${twitterUser}`,
            });
            return true;
        }

        if (createAssetResult?.UAL && reviewContent) {
            // add to vector database
            callback({
                text: `Created a new memory and successfully added it to the paranet! Thank you for enhancing the OriginTrail educational knowledge base 🎉\n\nRead my mind on @origin_trail Decentralized Knowledge Graph ${DKG_EXPLORER_LINKS[runtime.getSetting("DKG_ENVIRONMENT")]}${createAssetResult.UAL} @${twitterUser}`,
            });
        } else {
            callback({
                text: `Apologies, something went wrong with creating the memory and adding it to the paranet.`,
            });
        }

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "execute action DKG_INSERT",
                    action: "DKG_INSERT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "add to dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "store in dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
    ] as ActionExample[][],
} as Action;
