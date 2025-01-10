import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

const BASE_URL = process.env.EXPLORER_BASE_URL;

export async function sendNotification(
    action: string,
    identifiers: string[],
    content: any
): Promise<any> {
    try {
        const url = `${BASE_URL}/notify`;

        const payload = {
            action,
            identifiers,
            content,
        };

        const response = await axios.post(url, payload);

        return response;
    } catch (error) {
        console.error("Error sending notification:", error);
        throw error;
    }
}
