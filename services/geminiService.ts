
import { GoogleGenAI, Modality } from "@google/genai";

/**
 * Rewrites text to be neutral and safe for all audiences.
 * @param text The original text to rewrite.
 * @param apiKey The user-provided Gemini API key.
 * @returns The rewritten text.
 */
export const rewriteText = async (text: string, apiKey: string): Promise<string> => {
    if (!apiKey) {
        throw new Error("Gemini API key not provided.");
    }
    try {
        const ai = new GoogleGenAI({ apiKey });
        const prompt = `Rewrite the following text to be neutral and suitable for all audiences, ensuring it complies with safety policies. Do not add any commentary, explanation, or quotation marks. Just provide the rewritten text. Original text: "${text}"`;
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
        });

        const rewrittenText = response.text.trim();
        if (!rewrittenText) {
            throw new Error("The API failed to generate a rewritten version of the text.");
        }
        return rewrittenText;

    } catch (error) {
        console.error("Error in rewriteText service:", error);
        if (error instanceof Error) {
            throw new Error(`Failed to rewrite text: ${error.message}`);
        }
        throw new Error("Failed to rewrite text due to an unknown error.");
    }
};

/**
 * Converts text to speech using the Gemini API.
 * @param text The text to convert.
 * @param voiceName The desired voice.
 * @param apiKey The user-provided Gemini API key.
 * @returns A base64 encoded string of the audio data.
 */
export const textToSpeech = async (text: string, voiceName: string, apiKey: string): Promise<string> => {
    if (!apiKey) {
        throw new Error("Gemini API key not provided.");
    }
    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName },
                    },
                },
            },
        });
        
        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (!base64Audio) {
            // Check for safety filter blocks to provide a more specific error.
            if (response.promptFeedback?.blockReason) {
                const blockReason = response.promptFeedback.blockReason;
                const ratings = response.promptFeedback.safetyRatings?.map(r => `${r.category.replace('HARM_CATEGORY_', '')}: ${r.probability}`).join(', ');
                throw new Error(`Content blocked. Reason: ${blockReason}. ${ratings ? `(Details: ${ratings})` : ''}`);
            }
            throw new Error("No audio data received from API. The response may have been empty.");
        }

        return base64Audio;
    } catch (error) {
        console.error("Error in textToSpeech service:", error);
        if (error instanceof Error) {
            throw new Error(`Failed to convert text to speech: ${error.message}`);
        }
        throw new Error("Failed to convert text to speech due to an unknown error.");
    }
};
