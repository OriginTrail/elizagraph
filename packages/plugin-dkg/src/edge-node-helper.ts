import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

const createService = (baseURL, useAuth = false) => {
    const config = {
        baseURL,
        timeout: 180000,
        withCredentials: true, // Enable sending cookies with requests
    };

    // // If a service requires nginx
    // if (useAuth) {
    //     config["auth"] = {
    //         username: process.env.EDGE_NODE_AUTH_USERNAME,
    //         password: process.env.EDGE_NODE_AUTH_PASSWORD,
    //     };
    // }

    return axios.create(config);
};

export const edgeNodeService = createService(
    process.env.EDGE_NODE_BASE_URL,
    false,
);
