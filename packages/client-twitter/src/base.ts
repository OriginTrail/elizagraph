import {
    type Content,
    type IAgentRuntime,
    type IImageDescriptionService,
    type Memory,
    type State,
    type UUID,
    getEmbeddingZeroVector,
    elizaLogger,
    stringToUuid,
    ActionTimelineType,
} from "@elizaos/core";
import {
    type QueryTweetsResponse,
    Scraper,
    SearchMode,
    type Tweet,
} from "agent-twitter-client";
import { TwitterApi } from "twitter-api-v2";
import { EventEmitter } from "events";
import type { TwitterConfig } from "./environment.ts";

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

type TwitterProfile = {
    id: string;
    username: string;
    screenName: string;
    bio: string;
    nicknames: string[];
};

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing = false;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                console.error("Error processing request:", error);
                this.queue.unshift(request);
                await this.exponentialBackoff(this.queue.length);
            }
            await this.randomDelay();
        }

        this.processing = false;
    }

    private async exponentialBackoff(retryCount: number): Promise<void> {
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    private async randomDelay(): Promise<void> {
        const delay = Math.floor(Math.random() * 2000) + 1500;
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
}

export class ClientBase extends EventEmitter {
    static _twitterClients: { [accountIdentifier: string]: Scraper } = {};
    twitterClient: Scraper;
    v2Client: TwitterApi | null = null; // Twitter API v2 client for OAuth operations
    isInitialized: boolean = false; // Flag to prevent double initialization
    runtime: IAgentRuntime;
    twitterConfig: TwitterConfig;
    directions: string;
    lastCheckedTweetId: bigint | null = null;
    imageDescriptionService: IImageDescriptionService;
    temperature = 0.5;

    requestQueue: RequestQueue = new RequestQueue();

    profile: TwitterProfile | null;

    async cacheTweet(tweet: Tweet): Promise<void> {
        if (!tweet) {
            console.warn("Tweet is undefined, skipping cache");
            return;
        }

        this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
    }

    async getCachedTweet(tweetId: string): Promise<Tweet | undefined> {
        const cached = await this.runtime.cacheManager.get<Tweet>(
            `twitter/tweets/${tweetId}`
        );

        return cached;
    }

    async getTweet(tweetId: string): Promise<Tweet> {
        const cachedTweet = await this.getCachedTweet(tweetId);

        if (cachedTweet) {
            return cachedTweet;
        }

        // Use Twitter API v2 instead of the old Scraper (which uses guest tokens)
        if (!this.v2Client) {
            throw new Error("Twitter API v2 client not initialized");
        }

        const tweet = await this.requestQueue.add(async () => {
            const tweetData = await this.v2Client.v2.singleTweet(tweetId, {
                'tweet.fields': ['created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets'],
                'user.fields': ['username', 'name'],
                expansions: ['author_id']
            });

            if (!tweetData.data) {
                throw new Error(`Tweet ${tweetId} not found`);
            }

            const t = tweetData.data;
            const author = tweetData.includes?.users?.[0];

            // Convert v2 format to our Tweet format
            return {
                id: t.id,
                text: t.text || '',
                conversationId: t.conversation_id || t.id,
                timestamp: t.created_at ? new Date(t.created_at).getTime() / 1000 : Date.now() / 1000,
                userId: t.author_id || '',
                username: author?.username || '',
                name: author?.name || '',
                inReplyToStatusId: t.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id,
                permanentUrl: `https://twitter.com/${author?.username}/status/${t.id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: []
            } as Tweet;
        });

        await this.cacheTweet(tweet);
        return tweet;
    }

    callback: (self: ClientBase) => any = null;

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        super();
        this.runtime = runtime;
        this.twitterConfig = twitterConfig;
        const username = twitterConfig.TWITTER_USERNAME;
        if (ClientBase._twitterClients[username]) {
            this.twitterClient = ClientBase._twitterClients[username];
        } else {
            this.twitterClient = new Scraper();
            ClientBase._twitterClients[username] = this.twitterClient;
        }

        this.directions =
            "- " +
            this.runtime.character.style.all.join("\n- ") +
            "- " +
            this.runtime.character.style.post.join();
    }

    /**
     * Initialize Twitter API v2 client with OAuth 1.0a credentials
     * This is the clean, official way to authenticate with Twitter
     */
    private async initializeV2Client(): Promise<boolean> {
        try {
            const apiKey = this.twitterConfig.TWITTER_API_KEY;
            const apiSecret = this.twitterConfig.TWITTER_API_SECRET;
            const accessToken = this.twitterConfig.TWITTER_ACCESS_TOKEN;
            const accessSecret = this.twitterConfig.TWITTER_ACCESS_SECRET;

            if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
                elizaLogger.error("Missing Twitter OAuth credentials. Please set:");
                elizaLogger.error("- TWITTER_API_KEY");
                elizaLogger.error("- TWITTER_API_SECRET");
                elizaLogger.error("- TWITTER_ACCESS_TOKEN");
                elizaLogger.error("- TWITTER_ACCESS_SECRET");
                return false;
            }

            elizaLogger.info("Initializing Twitter API v2 client with OAuth credentials...");

            // Create Twitter API v2 client
            this.v2Client = new TwitterApi({
                appKey: apiKey,
                appSecret: apiSecret,
                accessToken: accessToken,
                accessSecret: accessSecret,
            });

            // Verify authentication by fetching user info
            elizaLogger.info("Verifying OAuth authentication...");
            const me = await this.v2Client.v2.me();

            if (me && me.data) {
                elizaLogger.success(`✅ Authenticated as @${me.data.username} (ID: ${me.data.id})`);

                // Initialize profile
                await this.initializeProfile(me.data.username);
                return true;
            } else {
                elizaLogger.error("OAuth authentication succeeded but no user data returned");
                return false;
            }
        } catch (error) {
            elizaLogger.error("Twitter OAuth authentication failed:", {
                message: error.message,
                code: error.code,
                rateLimit: error.rateLimit
            });
            return false;
        }
    }

    async init() {
        // Prevent double initialization
        if (this.isInitialized) {
            elizaLogger.debug("Twitter client already initialized, skipping...");
            return;
        }

        elizaLogger.info("Initializing Twitter client...");

        const success = await this.initializeV2Client();

        if (!success) {
            throw new Error(
                "Failed to initialize Twitter client. Please ensure you have set all required OAuth credentials:\n" +
                "  - TWITTER_API_KEY\n" +
                "  - TWITTER_API_SECRET\n" +
                "  - TWITTER_ACCESS_TOKEN\n" +
                "  - TWITTER_ACCESS_SECRET\n" +
                "These can be obtained from https://developer.twitter.com/en/portal/dashboard"
            );
        }

        this.isInitialized = true;
        elizaLogger.success("✅ Twitter client initialized successfully!");
    }

    async initializeProfile(username: string) {
        // Initialize Twitter profile
        this.profile = await this.fetchProfile(username);

        if (this.profile) {
            elizaLogger.log("Twitter user ID:", this.profile.id);
            elizaLogger.log(
                "Twitter loaded:",
                JSON.stringify(this.profile, null, 2)
            );
            // Store profile info for use in responses
            this.runtime.character.twitterProfile = {
                id: this.profile.id,
                username: this.profile.username,
                screenName: this.profile.screenName,
                bio: this.profile.bio,
                nicknames: this.profile.nicknames,
            };
        } else {
            throw new Error("Failed to load profile");
        }

        await this.loadLatestCheckedTweetId();
        
        // Skip populateTimeline when using OAuth - timeline will be populated
        // naturally as the bot processes mentions and interactions
        // await this.populateTimeline();
    }

    async clearCachedCookies(username: string) {
        try {
            await this.runtime.cacheManager.delete(`twitter/${username}/cookies`);
            elizaLogger.info(`Cleared cached cookies for ${username}`);
        } catch (error) {
            elizaLogger.warn(`Failed to clear cached cookies: ${error.message}`);
        }
    }

    async fetchOwnPosts(count: number): Promise<Tweet[]> {
        elizaLogger.debug("fetching own posts");
        const homeTimeline = await this.twitterClient.getUserTweets(
            this.profile.id,
            count
        );
        return homeTimeline.tweets;
    }

    /**
     * Fetch timeline for twitter account, optionally only from followed accounts
     */
    async fetchHomeTimeline(
        count: number,
        following?: boolean
    ): Promise<Tweet[]> {
        elizaLogger.debug("fetching home timeline");
        const homeTimeline = following
            ? await this.twitterClient.fetchFollowingTimeline(count, [])
            : await this.twitterClient.fetchHomeTimeline(count, []);

        elizaLogger.debug("Home timeline fetched:", JSON.stringify(homeTimeline, null, 2));
        const processedTimeline = homeTimeline
            .filter((t) => t.__typename !== "TweetWithVisibilityResults") // what's this about?
            .map((tweet) => {
                const obj = {
                    id: tweet.id,
                    name:
                        tweet.name ?? tweet?.user_results?.result?.legacy.name,
                    username:
                        tweet.username ??
                        tweet.core?.user_results?.result?.legacy.screen_name,
                    text: tweet.text ?? tweet.legacy?.full_text,
                    inReplyToStatusId:
                        tweet.inReplyToStatusId ??
                        tweet.legacy?.in_reply_to_status_id_str ??
                        null,
                    timestamp:
                        new Date(tweet.legacy?.created_at).getTime() / 1000,
                    createdAt:
                        tweet.createdAt ??
                        tweet.legacy?.created_at ??
                        tweet.core?.user_results?.result?.legacy.created_at,
                    userId: tweet.userId ?? tweet.legacy?.user_id_str,
                    conversationId:
                        tweet.conversationId ??
                        tweet.legacy?.conversation_id_str,
                    permanentUrl: `https://x.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
                    hashtags: tweet.hashtags ?? tweet.legacy?.entities.hashtags,
                    mentions:
                        tweet.mentions ?? tweet.legacy?.entities.user_mentions,
                    photos:
                        tweet.legacy?.entities?.media
                            ?.filter((media) => media.type === "photo")
                            .map((media) => ({
                                id: media.id_str,
                                url: media.media_url_https, // Store media_url_https as url
                                alt_text: media.alt_text,
                            })) || [],
                    thread: tweet.thread || [],
                    urls: tweet.urls ?? tweet.legacy?.entities.urls,
                    videos:
                        tweet.videos ??
                        tweet.legacy?.entities.media?.filter(
                            (media) => media.type === "video"
                        ) ??
                        [],
                };
                return obj;
            });
        return processedTimeline;
    }

    async fetchTimelineForActions(count: number): Promise<Tweet[]> {
        elizaLogger.debug("fetching timeline for actions");

        const agentUsername = this.twitterConfig.TWITTER_USERNAME;

        const homeTimeline =
            this.twitterConfig.ACTION_TIMELINE_TYPE ===
            ActionTimelineType.Following
                ? await this.twitterClient.fetchFollowingTimeline(count, [])
                : await this.twitterClient.fetchHomeTimeline(count, []);

        return homeTimeline
            .map((tweet) => ({
                id: tweet.rest_id,
                name: tweet.core?.user_results?.result?.legacy?.name,
                username: tweet.core?.user_results?.result?.legacy?.screen_name,
                text: tweet.legacy?.full_text,
                inReplyToStatusId: tweet.legacy?.in_reply_to_status_id_str,
                timestamp: new Date(tweet.legacy?.created_at).getTime() / 1000,
                userId: tweet.legacy?.user_id_str,
                conversationId: tweet.legacy?.conversation_id_str,
                permanentUrl: `https://twitter.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
                hashtags: tweet.legacy?.entities?.hashtags || [],
                mentions: tweet.legacy?.entities?.user_mentions || [],
                photos:
                    tweet.legacy?.entities?.media
                        ?.filter((media) => media.type === "photo")
                        .map((media) => ({
                            id: media.id_str,
                            url: media.media_url_https, // Store media_url_https as url
                            alt_text: media.alt_text,
                        })) || [],
                thread: tweet.thread || [],
                urls: tweet.legacy?.entities?.urls || [],
                videos:
                    tweet.legacy?.entities?.media?.filter(
                        (media) => media.type === "video"
                    ) || [],
            }))
            .filter((tweet) => tweet.username !== agentUsername) // do not perform action on self-tweets
            .slice(0, count);
        // TODO: Once the 'count' parameter is fixed in the 'fetchTimeline' method of the 'agent-twitter-client',
        // this workaround can be removed.
        // Related issue: https://github.com/elizaos/agent-twitter-client/issues/43
    }

    async fetchSearchTweets(
        query: string,
        maxTweets: number,
        searchMode: SearchMode,
        cursor?: string
    ): Promise<QueryTweetsResponse> {
        try {
            // Sometimes this fails because we are rate limited. in this case, we just need to return an empty array
            // if we dont get a response in 5 seconds, something is wrong
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve({ tweets: [] }), 15000)
            );

            try {
                const result = await this.requestQueue.add(
                    async () =>
                        await Promise.race([
                            this.twitterClient.fetchSearchTweets(
                                query,
                                maxTweets,
                                searchMode,
                                cursor
                            ),
                            timeoutPromise,
                        ])
                );
                return (result ?? { tweets: [] }) as QueryTweetsResponse;
            } catch (error) {
                elizaLogger.error("Error fetching search tweets:", error);
                return { tweets: [] };
            }
        } catch (error) {
            elizaLogger.error("Error fetching search tweets:", error);
            return { tweets: [] };
        }
    }

    private async populateTimeline() {
        elizaLogger.debug("populating timeline...");

        const cachedTimeline = await this.getCachedTimeline();

        // Check if the cache file exists
        if (cachedTimeline) {
            // Read the cached search results from the file

            // Get the existing memories from the database
            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    roomIds: cachedTimeline.map((tweet) =>
                        stringToUuid(
                            tweet.conversationId + "-" + this.runtime.agentId
                        )
                    ),
                });

            //TODO: load tweets not in cache?

            // Create a Set to store the IDs of existing memories
            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            // Check if any of the cached tweets exist in the existing memories
            const someCachedTweetsExist = cachedTimeline.some((tweet) =>
                existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
            );

            if (someCachedTweetsExist) {
                // Filter out the cached tweets that already exist in the database
                const tweetsToSave = cachedTimeline.filter(
                    (tweet) =>
                        !existingMemoryIds.has(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        )
                );

                elizaLogger.debug("Processing tweets:", {
                    tweetIds: tweetsToSave
                        .map((tweet) => tweet.id)
                        .join(","),
                });

                // Save the missing tweets as memories
                for (const tweet of tweetsToSave) {
                    elizaLogger.log("Saving Tweet", tweet.id);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const userId =
                        tweet.userId === this.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId);

                    if (tweet.userId === this.profile.id) {
                        await this.runtime.ensureConnection(
                            this.runtime.agentId,
                            roomId,
                            this.profile.username,
                            this.profile.screenName,
                            "twitter"
                        );
                    } else {
                        await this.runtime.ensureConnection(
                            userId,
                            roomId,
                            tweet.username,
                            tweet.name,
                            "twitter"
                        );
                    }

                    const content = {
                        text: tweet.text,
                        url: tweet.permanentUrl,
                        source: "twitter",
                        inReplyTo: tweet.inReplyToStatusId
                            ? stringToUuid(
                                  tweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    } as Content;

                    elizaLogger.log("Creating memory for tweet", tweet.id);

                    // check if it already exists
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );

                    if (memory) {
                        elizaLogger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        break;
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp * 1000,
                    });

                    await this.cacheTweet(tweet);
                }

                elizaLogger.log(
                    `Populated ${tweetsToSave.length} missing tweets from the cache.`
                );
                return;
            }
        }

        const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
        const username = this.twitterConfig.TWITTER_USERNAME;

        // Get the most recent 20 mentions and interactions
        const mentionsAndInteractions = await this.fetchSearchTweets(
            `@${username}`,
            20,
            SearchMode.Latest
        );

        // Combine the timeline tweets and mentions/interactions
        const allTweets = [...timeline, ...mentionsAndInteractions.tweets];

        // Create a Set to store unique tweet IDs
        const tweetIdsToCheck = new Set<string>();
        const roomIds = new Set<UUID>();

        // Add tweet IDs to the Set
        for (const tweet of allTweets) {
            tweetIdsToCheck.add(tweet.id);
            roomIds.add(
                stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
            );
        }

        // Check the existing memories in the database
        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: Array.from(roomIds),
            });

        // Create a Set to store the existing memory IDs
        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.id)
        );

        // Filter out the tweets that already exist in the database
        const tweetsToSave = allTweets.filter(
            (tweet) =>
                !existingMemoryIds.has(
                    stringToUuid(tweet.id + "-" + this.runtime.agentId)
                )
        );

        elizaLogger.debug({
            processingTweets: tweetsToSave.map((tweet) => tweet.id).join(","),
        });

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.profile.username,
            this.runtime.character.name,
            "twitter"
        );

        // Save the new tweets as memories
        for (const tweet of tweetsToSave) {
            elizaLogger.log("Saving Tweet", tweet.id);

            const roomId = stringToUuid(
                tweet.conversationId + "-" + this.runtime.agentId
            );
            const userId =
                tweet.userId === this.profile.id
                    ? this.runtime.agentId
                    : stringToUuid(tweet.userId);

            if (tweet.userId === this.profile.id) {
                await this.runtime.ensureConnection(
                    this.runtime.agentId,
                    roomId,
                    this.profile.username,
                    this.profile.screenName,
                    "twitter"
                );
            } else {
                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    tweet.username,
                    tweet.name,
                    "twitter"
                );
            }

            const content = {
                text: tweet.text,
                url: tweet.permanentUrl,
                source: "twitter",
                inReplyTo: tweet.inReplyToStatusId
                    ? stringToUuid(tweet.inReplyToStatusId)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                userId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: tweet.timestamp * 1000,
            });

            await this.cacheTweet(tweet);
        }

        // Cache
        await this.cacheTimeline(timeline);
        await this.cacheMentions(mentionsAndInteractions.tweets);
    }

    async setCookiesFromArray(cookiesArray: any[]) {
        const cookieStrings = cookiesArray.map(
            (cookie) =>
                `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                    cookie.secure ? "Secure" : ""
                }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                    cookie.sameSite || "Lax"
                }`
        );
        await this.twitterClient.setCookies(cookieStrings);
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                elizaLogger.debug("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: getEmbeddingZeroVector(),
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                twitterClient: this.twitterClient,
            });
        }
    }

    async loadLatestCheckedTweetId(): Promise<void> {
        const latestCheckedTweetId =
            await this.runtime.cacheManager.get<string>(
                `twitter/${this.profile.username}/latest_checked_tweet_id`
            );

        if (latestCheckedTweetId) {
            this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
        }
    }

    async cacheLatestCheckedTweetId() {
        if (this.lastCheckedTweetId) {
            await this.runtime.cacheManager.set(
                `twitter/${this.profile.username}/latest_checked_tweet_id`,
                this.lastCheckedTweetId.toString()
            );
        }
    }

    async getCachedTimeline(): Promise<Tweet[] | undefined> {
        return await this.runtime.cacheManager.get<Tweet[]>(
            `twitter/${this.profile.username}/timeline`
        );
    }

    async cacheTimeline(timeline: Tweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile.username}/timeline`,
            timeline,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async cacheMentions(mentions: Tweet[]) {
        await this.runtime.cacheManager.set(
            `twitter/${this.profile.username}/mentions`,
            mentions,
            { expires: Date.now() + 10 * 1000 }
        );
    }

    async getCachedCookies(username: string) {
        return await this.runtime.cacheManager.get<any[]>(
            `twitter/${username}/cookies`
        );
    }

    async cacheCookies(username: string, cookies: any[]) {
        await this.runtime.cacheManager.set(
            `twitter/${username}/cookies`,
            cookies
        );
    }

    async fetchProfile(username: string): Promise<TwitterProfile> {
        try {
            if (!this.v2Client) {
                throw new Error("Twitter API v2 client not initialized");
            }

            const profile = await this.requestQueue.add(async () => {
                // Use Twitter API v2 to fetch user by username
                const user = await this.v2Client.v2.userByUsername(username, {
                    'user.fields': ['description', 'name', 'id']
                });

                if (!user.data) {
                    throw new Error(`User @${username} not found`);
                }

                return {
                    id: user.data.id,
                    username: username,
                    screenName: user.data.name || this.runtime.character.name,
                    bio:
                        user.data.description ||
                        typeof this.runtime.character.bio === "string"
                            ? (this.runtime.character.bio as string)
                            : this.runtime.character.bio.length > 0
                              ? this.runtime.character.bio[0]
                              : "",
                    nicknames:
                        this.runtime.character.twitterProfile?.nicknames || [],
                } satisfies TwitterProfile;
            });

            return profile;
        } catch (error) {
            elizaLogger.error("Error fetching Twitter profile:", error);
            throw error;
        }
    }

    /**
     * Fetch mentions for the authenticated user using Twitter API v2
     * @param maxResults Maximum number of mentions to fetch (default: 10, max: 100)
     * @param sinceId Only return tweets after this tweet ID
     * @returns Array of Tweet objects representing mentions
     */
    async fetchMentions(maxResults: number = 10, sinceId?: string): Promise<Tweet[]> {
        try {
            if (!this.v2Client) {
                throw new Error("Twitter API v2 client not initialized");
            }

            if (!this.profile || !this.profile.id) {
                throw new Error("User profile not initialized");
            }

            elizaLogger.info(`Fetching up to ${maxResults} mentions${sinceId ? ` since tweet ${sinceId}` : ''}...`);

            // Fetch mentions using Twitter API v2
            const mentionsParams: any = {
                max_results: Math.min(maxResults, 100), // API max is 100
                'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets', 'author_id'],
                'user.fields': ['username', 'name'],
                expansions: ['author_id', 'referenced_tweets.id']
            };

            if (sinceId) {
                mentionsParams.since_id = sinceId;
            }

            const mentions = await this.v2Client.v2.userMentionTimeline(
                this.profile.id,
                mentionsParams
            );

            // Convert to Tweet format
            const tweets: Tweet[] = [];
            for await (const tweet of mentions) {
                const author = mentions.includes.users?.find(u => u.id === tweet.author_id);

                tweets.push({
                    id: tweet.id,
                    text: tweet.text,
                    conversationId: tweet.conversation_id || tweet.id,
                    timestamp: tweet.created_at ? new Date(tweet.created_at).getTime() / 1000 : Date.now() / 1000,
                    userId: tweet.author_id,
                    username: author?.username || 'unknown',
                    name: author?.name,
                    inReplyToStatusId: tweet.referenced_tweets?.find(ref => ref.type === 'replied_to')?.id,
                    permanentUrl: `https://twitter.com/${author?.username || 'i'}/status/${tweet.id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet);
            }

            elizaLogger.info(`Found ${tweets.length} mention(s)`);
            return tweets;
        } catch (error) {
            elizaLogger.error("Error fetching mentions:", {
                message: error.message,
                code: error.code,
                rateLimit: error.rateLimit
            });

            // If rate limit error, provide helpful info
            if (error.code === 429 || error.rateLimit) {
                elizaLogger.warn("Rate limit hit when fetching mentions. Consider:");
                elizaLogger.warn("1. Increasing the polling interval");
                elizaLogger.warn("2. Upgrading to Twitter API paid tier");
                elizaLogger.warn(`3. Rate limit resets at: ${error.rateLimit?.reset ? new Date(error.rateLimit.reset * 1000).toLocaleString() : 'unknown'}`);
            }

            throw error;
        }
    }
}
