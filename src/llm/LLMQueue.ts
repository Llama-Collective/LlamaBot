// import got from "got";
import { LLMRequest } from "./LLMRequest.js";
import { LLMResponseFuture as LLMResponseFuture } from "./LLMResponseFuture.js";
import { LLMRequestAndPromise } from "./LLMRequestAndPromise.js";
import { LLMResponse } from "./LLMResponse.js";
import { Bot } from "../Bot.js";
import { generateText, jsonSchema, Output } from "ai";
import { SubmissionRecords } from "../utils/MarkdownUtils.js";
import { JSONSchema7 } from "json-schema";


// const URL = 'http://localhost:8000/generate'

/**
 * Manages a queue of LLM requests.
 */
export class LLMQueue {
    /**
     * The queue of LLM requests.
     */
    private _llmQueue: LLMRequestAndPromise[] = [];

    private _processing: boolean = false;

    constructor(private bot: Bot) {
        this._llmQueue = [];
    }

    /**
     * Adds a new request to the queue and processes it if the queue is empty.
     * @param request The LLMRequest to add to the queue.
     */
    public addRequest(request: LLMRequest): LLMResponseFuture {
        // Validate the request's prompt input
        const validation = request.prompt.validateInput();
        if (validation instanceof Error) {
            throw validation;
        }

        const promise = new Promise<LLMResponse>((resolve, reject) => {
            const requestAndPromise: LLMRequestAndPromise = {
                request: request,
                resolve: resolve,
                reject: reject
            };

            // Insert the request into the queue based on its priority
            this.insertQueue(requestAndPromise);

            // If the queue is empty, process the request immediately
            if (this._llmQueue.length === 1) {
                return this.processNextRequest();
            }
        });

        return new LLMResponseFuture(promise);
    }

    /**
     * Processes the next request in the queue.
     * @returns The response from the LLM for the processed request.
     */
    public async processNextRequest() {
        // If the queue is empty, return an empty string
        if (this._llmQueue.length === 0) {
            return;
        }

        if (this._processing) {
            // If already processing, do not start another request
            return;
        }

        this._processing = true;


        // Pop the next request from the queue
        const request = this.popQueue();
        if (!request) {
            return;
        }

        // Process the request and return the response
        try {
            const response = await this.processRequest(request.request);
            // Resolve the promise with the response
            request.resolve(response);
        } catch (error: any) {
            request.reject(error);
            console.error('Error processing LLM request:', error.message);
        } finally {
            this._processing = false;
            // If there are more requests in the queue, process the next one
            if (this._llmQueue.length > 0) {
                this.processNextRequest();
            }
        }
    }


    /**
     * Adds a new request to the queue.
     * @param request The LLMRequest to add to the queue.
     */
    private insertQueue(request: LLMRequestAndPromise): void {
        // Insert the request into the queue based on its priority. Higher priority requests (higher numbers) are processed first.
        let inserted = false;
        for (let i = 0; i < this._llmQueue.length; i++) {
            if (request.request.priority > this._llmQueue[i].request.priority) {
                this._llmQueue.splice(i, 0, request);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this._llmQueue.push(request);
        }
    }

    /**
     * Removes and returns the next request from the queue.
     * @returns The next LLMRequest or undefined if the queue is empty.
     */
    private popQueue(): LLMRequestAndPromise | undefined {
        return this._llmQueue.shift();
    }

    private async localModelProcess(_request: LLMRequest): Promise<LLMResponse> {
        throw new Error('Local model processing is currently disabled.');

        // const prompt = request.prompt.generatePrompt();
        // const res = await got.post(URL, {
        //     json: {
        //         schema_text: JSON.stringify(request.schema),
        //         input_text: prompt
        //     },
        //     timeout: {
        //         request: 60000 // 60 seconds
        //     }
        // }).json() as LLMResponse;
        // if (res.error) {
        //     throw new Error(res.error);
        // }
        // return res;
    }

    private async paidModelProcess(request: LLMRequest): Promise<LLMResponse> {
        const paidLLMClient = this.bot.openAIClient;
        if (!paidLLMClient) {
            throw new Error('Paid LLM client is not configured');
        }

        const result = await generateText({
            model: paidLLMClient("gpt-5.4-nano"),
            output: Output.object({
                schema: jsonSchema(this.toOpenAIStrictSchema(request.schema))
            }),
            prompt: request.prompt.generatePrompt(),
        })

        if (!result.output) {
            throw new Error('LLM did not return a valid object');
        }

        return {
            result: this.removeNullValues(result.output) as SubmissionRecords,
            error: undefined
        }
    }

    private toOpenAIStrictSchema(schema: JSONSchema7): JSONSchema7 {
        const strictSchema = structuredClone(schema);
        this.normalizeObjectSchema(strictSchema);
        return strictSchema;
    }

    private normalizeObjectSchema(schema: JSONSchema7): void {
        if (schema.properties) {
            const required = new Set((schema.required || []).map(String));
            const propertyNames = Object.keys(schema.properties);

            for (const propertyName of propertyNames) {
                const propertySchema = schema.properties[propertyName];
                if (typeof propertySchema === 'boolean') {
                    continue;
                }

                this.normalizeObjectSchema(propertySchema);

                if (!required.has(propertyName)) {
                    schema.properties[propertyName] = this.makeNullable(propertySchema);
                }
            }

            schema.required = propertyNames;
            schema.additionalProperties = false;
        }

        if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
            this.normalizeObjectSchema(schema.items);
        }

        for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
            const variants = schema[key];
            if (Array.isArray(variants)) {
                for (const variant of variants) {
                    if (typeof variant !== 'boolean') {
                        this.normalizeObjectSchema(variant);
                    }
                }
            }
        }
    }

    private makeNullable(schema: JSONSchema7): JSONSchema7 {
        if (schema.type === 'null') {
            return schema;
        }

        if (Array.isArray(schema.type) && schema.type.includes('null')) {
            return schema;
        }

        if (schema.anyOf?.some(variant => typeof variant !== 'boolean' && variant.type === 'null')) {
            return schema;
        }

        return {
            anyOf: [
                schema,
                { type: 'null' }
            ]
        };
    }

    private removeNullValues(value: unknown): unknown {
        if (value === null || value === undefined) {
            return undefined;
        }

        if (Array.isArray(value)) {
            return value
                .map(item => this.removeNullValues(item))
                .filter(item => item !== undefined);
        }

        if (typeof value === 'object') {
            const output: Record<string, unknown> = {};
            for (const [key, nestedValue] of Object.entries(value)) {
                const cleanedValue = this.removeNullValues(nestedValue);
                if (cleanedValue !== undefined) {
                    output[key] = cleanedValue;
                }
            }
            return output;
        }

        return value;
    }

    private async processRequest(request: LLMRequest): Promise<LLMResponse> {
        try {
            const paidLLMClient = this.bot.openAIClient;
            if (!paidLLMClient) {
                return await this.localModelProcess(request);
            }

            try {
                return await this.paidModelProcess(request);
            } catch (error) {
                console.error('Error with paid LLM model, falling back to local model:', error);
                return await this.localModelProcess(request);
            }
        } catch (error) {
            console.error('Error fetching LLM response:', error)
            throw error
        }
    }
}
