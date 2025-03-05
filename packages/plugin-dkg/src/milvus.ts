import dotenv from "dotenv";
dotenv.config();
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import axios from "axios";

const client = new MilvusClient({
    address: process.env.MILVUS_ADDRESS,
    token: process.env.MILVUS_TOKEN,
});

interface MilvusData {
    [x: string]: number[] | string;
    vector: number[];
    text: string;
    ual: string;
}

export async function getEmbedding(text: string): Promise<number[]> {
    const response = await axios.post(
        "https://api.voyageai.com/v1/embeddings",
        {
            input: text,
            model: "voyage-3",
            input_type: "document",
        },
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            },
        },
    );

    return response.data.data[0].embedding;
}

export async function insertData(data: MilvusData[], collectionName: string) {
    await client.insert({
        collection_name: collectionName,
        data: data,
    });
}

export async function searchData(
    collectionName: string,
    data: number[],
    topK: number = 3,
) {
    return await client.search({
        collection_name: collectionName,
        data: [data],
        limit: topK,
    });
}
