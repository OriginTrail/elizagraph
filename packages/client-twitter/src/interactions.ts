import { SearchMode, type Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
    type IImageDescriptionService,
    ServiceType,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with [RESPOND], [IGNORE], or [STOP].

Response options are [RESPOND], [IGNORE] and [STOP].

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun: boolean;
    private mentionQueue: Tweet[] = []; // Queue for processing mentions one at a time
    private lastFetchTime: number = 0; // Track when we last fetched mentions

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    }

    async start() {
        elizaLogger.info(`🚀 Starting Twitter interaction loop (poll interval: ${this.client.twitterConfig.TWITTER_POLL_INTERVAL}s)`);

        const handleTwitterInteractionsLoop = async () => {
            elizaLogger.info(`⏰ Interaction loop cycle starting...`);
            try {
                await this.handleTwitterInteractions();
            } catch (error) {
                elizaLogger.error("🔥🔥🔥 UNCAUGHT ERROR in interaction loop:", error);
                elizaLogger.error("Error stack:", error instanceof Error ? error.stack : undefined);
            }

            const nextRunIn = this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000;
            elizaLogger.info(`⏰ Next check in ${this.client.twitterConfig.TWITTER_POLL_INTERVAL}s (will process next tweet from queue or check if it's time to fetch)`);

            setTimeout(
                handleTwitterInteractionsLoop,
                nextRunIn,
            );
        };

        elizaLogger.info(`⏰ Triggering first interaction loop cycle NOW...`);
        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            elizaLogger.log(`[DEBUG] Queue status: ${this.mentionQueue.length} mentions`);

            const now = Date.now();
            const timeSinceLastFetch = (now - this.lastFetchTime) / 1000; // seconds

            // Only fetch when queue is EMPTY and enough time has passed (2 min cooldown)
            // Always fetch 100 (max batch) to minimize API calls
            // Processing 100 tweets takes ~3 hours, so rate limit is safe (10 requests per 15 min)
            const shouldFetch = this.mentionQueue.length === 0 && (
                this.lastFetchTime === 0 || timeSinceLastFetch >= 120
            );

            elizaLogger.info(`[DEBUG] shouldFetch: ${shouldFetch}, timeSinceLastFetch: ${Math.floor(timeSinceLastFetch)}s, queue: ${this.mentionQueue.length}`);

            // Fetch 100 mentions when queue is completely empty
            if (shouldFetch) {
                elizaLogger.info(`🔍 Queue empty, fetching new mentions... (${Math.floor(timeSinceLastFetch)}s since last fetch)`);

                const lastTweetId = this.client.lastCheckedTweetId
                    ? this.client.lastCheckedTweetId.toString()
                    : undefined;

                elizaLogger.info(`📡 Fetching 100 mentions (max batch)${lastTweetId ? ` since tweet ${lastTweetId}` : ' - first run, will get backlog'}`);

                const mentionCandidates = await this.client.fetchMentions(
                    100, // Always fetch 100 to minimize API calls
                    lastTweetId
                );

                this.lastFetchTime = now;

                elizaLogger.info(
                    `✅ Fetched ${mentionCandidates.length} new mention(s). ${mentionCandidates.length > 0 ? 'Adding to queue...' : 'No new mentions found.'}`,
                );

                elizaLogger.info(`[DEBUG] About to process ${mentionCandidates.length} mentions and add to queue`);

                // Add new mentions to queue (avoiding duplicates)
                const existingIds = new Set(this.mentionQueue.map(t => t.id));
                elizaLogger.info(`[DEBUG] Existing IDs in queue: ${Array.from(existingIds).join(', ')}`);

                const newMentions = mentionCandidates.filter(t => !existingIds.has(t.id));
                elizaLogger.info(`[DEBUG] After filtering: ${newMentions.length} new mentions (${mentionCandidates.length - newMentions.length} duplicates removed)`);

                // Sort mentions by ID ascending (oldest first) so we answer in order
                newMentions.sort((a, b) => {
                    const idA = BigInt(a.id);
                    const idB = BigInt(b.id);
                    if (idA < idB) return -1;
                    if (idA > idB) return 1;
                    return 0;
                });

                this.mentionQueue.push(...newMentions);

                elizaLogger.info(`✅ Added ${newMentions.length} mention(s) to queue (sorted oldest→newest for processing)`);
                elizaLogger.info(`📋 Queue now has ${this.mentionQueue.length} total mention(s). Will process one every ${this.client.twitterConfig.TWITTER_POLL_INTERVAL}s`);

                // Update lastCheckedTweetId to the NEWEST tweet from this fetch
                // This prevents re-fetching the same batch
                if (newMentions.length > 0) {
                    const newestTweetId = newMentions[newMentions.length - 1].id; // Last item after sorting is newest
                    this.client.lastCheckedTweetId = BigInt(newestTweetId);
                    await this.client.cacheLatestCheckedTweetId();
                    elizaLogger.info(`📌 Saved checkpoint at tweet ${newestTweetId} (will fetch from here next time)`);
                }
            } else if (this.mentionQueue.length === 0 && timeSinceLastFetch < 120) {
                const waitTime = Math.ceil(120 - timeSinceLastFetch);
                elizaLogger.info(`⏳ Queue empty, but not fetching yet. Need to wait ${waitTime}s more (2 min cooldown between fetches)`);
            }

            // If queue is empty, nothing to process
            if (this.mentionQueue.length === 0) {
                elizaLogger.info(`💤 No mentions in queue. Will check again in ${this.client.twitterConfig.TWITTER_POLL_INTERVAL}s`);
                return;
            }

            // Process ONLY the first mention from the queue
            const nextMention = this.mentionQueue.shift()!;
            elizaLogger.info(`📝 Processing tweet ${nextMention.id} from queue (${this.mentionQueue.length} remaining, will process next in ${this.client.twitterConfig.TWITTER_POLL_INTERVAL}s)`);
            const mentionCandidates = [nextMention];

            let uniqueTweetCandidates = [...mentionCandidates];
            // Only process target users if configured
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS =
                    this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            // Fetch tweets from target user using OAuth v2 search
                            const searchResults = await this.client.fetchSearchTweets(
                                `from:${username}`,
                                3,
                                SearchMode.Latest
                            );
                            const userTweets = searchResults.tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter((tweet) => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    Number.parseInt(tweet.id) >
                                        this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.log(
                                    `Found ${validTweets.length} valid tweets from ${username}`,
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error,
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each user that has tweets
                    const selectedTweets: Tweet[] = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            // Randomly select one tweet from this user
                            const randomTweet =
                                tweets[
                                    Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.log(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`,
                            );
                        }
                    }

                    // Add selected tweets to candidates
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets,
                    ];
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions",
                );
            }

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                // Generate the tweetId UUID the same way it's done in handleTweet
                const tweetId = stringToUuid(
                    tweet.id + "-" + this.runtime.agentId,
                );

                // Check if we've already processed this tweet
                const existingResponse =
                    await this.runtime.messageManager.getMemoryById(
                        tweetId,
                    );

                if (existingResponse) {
                    elizaLogger.info(
                        `Already responded to tweet ${tweet.id}, skipping`,
                    );
                    continue;
                }
                elizaLogger.info("✨ New Tweet found", tweet.permanentUrl);

                try {
                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId,
                    );

                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter",
                    );

                    const thread = await buildConversationThread(
                        tweet,
                        this.client,
                    );

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    elizaLogger.info(`✅ Successfully processed tweet ${tweet.id}`);
                } catch (tweetError) {
                    elizaLogger.error(
                        `❌ Error processing tweet ${tweet.id} (may have been deleted):`,
                        tweetError
                    );
                    // Continue to next tweet in queue instead of crashing
                    continue;
                }
            }

            elizaLogger.log("Finished checking Twitter interactions");
        } catch (error) {
            elizaLogger.error("❌❌❌ CRITICAL ERROR in Twitter interactions:", error);
            elizaLogger.error("Error details:", {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Only skip if tweet is from self AND not from a target user
        if (
            tweet.userId === this.client.profile.id &&
            !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(
                tweet.username,
            )
        ) {
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000,
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`,
            )
            .join("\n\n");

        const imageDescriptionsArray = [];
        try {
            for (const photo of tweet.photos) {
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION,
                    )
                    .describeImage(photo.url);
                imageDescriptionsArray.push(description);
            }
        } catch (error) {
            // Handle the error
            elizaLogger.error("Error Occured during describing image: ", error);
        }

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client, // ClientBase instance with OAuth v2 methods
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            imageDescriptions:
                imageDescriptionsArray.length > 0
                    ? `\nImages in Tweet:\n${imageDescriptionsArray
                          .map(
                              (desc, i) =>
                                  `Image ${i + 1}: Title: ${desc.title}\nDescription: ${desc.description}`,
                          )
                          .join("\n\n")}`
                    : "",
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId,
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        const validTargetUsersStr =
            this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        // if (shouldRespond !== "RESPOND") {
        //     elizaLogger.log("Not responding to message");
        //     return { text: "Response Decision:", action: shouldRespond };
        // }

        const context = composeContext({
            state: {
                ...state,
                // Convert actionNames array to string
                actionNames: Array.isArray(state.actionNames)
                    ? state.actionNames.join(", ")
                    : state.actionNames || "",
                actions: Array.isArray(state.actions)
                    ? state.actions.join("\n")
                    : state.actions || "",
                // Ensure character examples are included
                characterPostExamples: this.runtime.character.messageExamples
                    ? this.runtime.character.messageExamples
                          .map((example) =>
                              example
                                  .map(
                                      (msg) =>
                                          `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ""}`,
                                  )
                                  .join("\n"),
                          )
                          .join("\n\n")
                    : "",
            },
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`,
                );
            } else {
                try {
                    const callback: HandlerCallback = async (
                        response: Content,
                    ) => {
                        const memories = await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id,
                        );
                        return memories;
                    };

                    const responseMessages = await callback(response);

                    state = (await this.runtime.updateRecentMessageState(
                        state,
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        if (
                            responseMessage ===
                            responseMessages[responseMessages.length - 1]
                        ) {
                            responseMessage.content.action = response.action;
                        } else {
                            responseMessage.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(
                            responseMessage,
                        );
                    }

                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        callback,
                    );

                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                    await this.runtime.cacheManager.set(
                        `twitter/tweet_generation_${tweet.id}.txt`,
                        responseInfo,
                    );
                    await wait();
                } catch (error) {
                    elizaLogger.error(`Error sending response tweet: ${error}`);
                }
            }
        }
    }

    async buildConversationThread(
        tweet: Tweet,
        maxReplies = 10,
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId),
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId,
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter",
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId,
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId,
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId,
                );
                try {
                    const parentTweet = await this.client.getTweet(
                        currentTweet.inReplyToStatusId,
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId,
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id,
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        return thread;
    }
}
