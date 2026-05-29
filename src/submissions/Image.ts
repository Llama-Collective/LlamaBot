import { BaseAttachment } from "./Attachment.js"

export type Image = BaseAttachment & {
    width?: number,
    height?: number
    processedUrl?: string, // URL to the processed image if available
}