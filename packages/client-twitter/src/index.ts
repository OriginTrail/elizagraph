import { type Client, elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { validateTwitterConfig, type TwitterConfig } from "./environment.ts";
import { TwitterInteractionClient } from "./interactions.ts";
import { TwitterPostClient } from "./post.ts";
import { TwitterSearchClient } from "./search.ts";
import { TwitterSpaceClient } from "./spaces.ts";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - search: searching tweets / replying logic
 * - interaction: handling mentions, replies
 * - space: launching and managing Twitter Spaces (optional)
 */
class TwitterManager {
    client: ClientBase;
    post: TwitterPostClient;
    search: TwitterSearchClient;
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;

    constructor(runtime: IAgentRuntime, twitterConfig: TwitterConfig) {
        // Pass twitterConfig to the base client
        this.client = new ClientBase(runtime, twitterConfig);

        // Posting logic
        this.post = new TwitterPostClient(this.client, runtime);

        // Optional search logic (enabled if TWITTER_SEARCH_ENABLE is true)
        if (twitterConfig.TWITTER_SEARCH_ENABLE) {
            elizaLogger.warn("Twitter/X client running in a mode that:");
            elizaLogger.warn("1. violates consent of random users");
            elizaLogger.warn("2. burns your rate limit");
            elizaLogger.warn("3. can get your account banned");
            elizaLogger.warn("use at your own risk");
            this.search = new TwitterSearchClient(this.client, runtime);
        }

        // Mentions and interactions
        this.interaction = new TwitterInteractionClient(this.client, runtime);

        // Optional Spaces logic (enabled if TWITTER_SPACES_ENABLE is true)
        if (twitterConfig.TWITTER_SPACES_ENABLE) {
            this.space = new TwitterSpaceClient(this.client, runtime);
        }
    }
}

export const TwitterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        elizaLogger.info("🔵 TwitterClientInterface.start() CALLED - Beginning initialization...");

        const twitterConfig: TwitterConfig =
            await validateTwitterConfig(runtime);

        elizaLogger.info("🔵 Twitter config validated, creating manager...");
        elizaLogger.info("Twitter client started");

        const manager = new TwitterManager(runtime, twitterConfig);
        elizaLogger.info("🔵 Manager created, starting client.init()...");

        // Initialize login/session
        await manager.client.init();
        elizaLogger.info("🔵 Client.init() completed, starting post loop...");

        // Start the posting loop (now uses OAuth v2 API)
        await manager.post.start();
        elizaLogger.info("🔵 Post loop started, checking for search...");

        // Start the search logic if it exists (now uses OAuth v2 API)
        if (manager.search) {
            await manager.search.start();
            elizaLogger.info("🔵 Search started");
        } else {
            elizaLogger.info("🔵 Search disabled, skipping");
        }

        elizaLogger.info("🔵 Starting interaction loop...");
        // Start interactions (mentions, replies)
        await manager.interaction.start();
        elizaLogger.info("🔵 Interaction loop started!");

        // If Spaces are enabled, start the periodic check
        if (manager.space) {
            manager.space.startPeriodicSpaceCheck();
        }

        return manager;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("Twitter client does not support stopping yet");
    },
};

export default TwitterClientInterface;
