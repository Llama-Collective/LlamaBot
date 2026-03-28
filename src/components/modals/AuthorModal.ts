import { LabelBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Modal } from "../../interface/Modal.js";
import { areAuthorsSame, canEditSubmission, getAuthorKey, getAuthorName, getAuthorsString, getDiscordAuthorsFromIDs, reclassifyAuthors, replyEphemeral, truncateStringWithEllipsis } from "../../utils/Util.js";
import { AllAuthorPropertiesAccessor, Author, AuthorType } from "../../submissions/Author.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { SetAuthorsMenu } from "../menus/SetAuthorsMenu.js";
import { SetArchiveCategoryMenu } from "../menus/SetArchiveCategoryMenu.js";
import { EditAuthorsButton } from "../buttons/EditAuthorsButton.js";

export class AuthorModal implements Modal {
    getID(): string {
        return "author-modal";
    }

    getBuilder(authorNumber: number, author?: Author): ModalBuilder {
        const modal = new ModalBuilder()
            .setCustomId(this.getID() + '|' + (author ? getAuthorKey(author).substring(0, 50) : '')) // In case something goes wrong with the author name, we don't want it to exceed Discord's limits
            .setTitle(truncateStringWithEllipsis(author ? `Edit Author: ${getAuthorName(author)}` : `Add Author`, 80))

        const authorAllFields = author as (AllAuthorPropertiesAccessor | undefined);
        const userIDInput = new TextInputBuilder()
            .setCustomId('idInput')
            .setPlaceholder('Discord User ID is preferred')
            .setStyle(TextInputStyle.Short)
            .setValue(author?.type === AuthorType.Unknown ? authorAllFields?.username || '' : authorAllFields?.id || '')
            .setRequired(true)

        const userIDLabel = new LabelBuilder()
            .setLabel('Discord User ID or Name:')
            .setTextInputComponent(userIDInput);


        const url = new TextInputBuilder()
            .setCustomId('urlInput')
            .setPlaceholder('e.g. https://reddit.com/u/username')
            .setStyle(TextInputStyle.Short)
            .setValue(author?.url || '')
            .setRequired(false)

        const urlLabel = new LabelBuilder()
            .setLabel('Optional URL for the author:')
            .setTextInputComponent(url);

        const reason = new TextInputBuilder()
            .setCustomId('reasonInput')
            .setPlaceholder('e.g. "for emotional support"')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(author?.reason || '')
            .setRequired(false)

        const reasonLabel = new LabelBuilder()
            .setLabel('Reason for adding (optional):')
            .setTextInputComponent(reason);

        const shouldDisplay = new StringSelectMenuBuilder()
            .setCustomId('shouldDisplay')
            .setMinValues(1)
            .setMaxValues(1)
            .setOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('Yes')
                    .setValue('yes')
                    .setDescription('Display this author on the by line')
                    .setDefault(!(author?.dontDisplay)),
                new StringSelectMenuOptionBuilder()
                    .setLabel('No')
                    .setValue('no')
                    .setDescription('Do not display this author on the by line')
                    .setDefault(!!(author?.dontDisplay))
            )
            .setRequired(true)

        const shouldDisplayLabel = new LabelBuilder()
            .setLabel('Display this author on the by line?')
            .setStringSelectMenuComponent(shouldDisplay);

        const orderInput = new TextInputBuilder()
            .setCustomId('orderInput')
            .setPlaceholder('Lower numbers are displayed first.')
            .setStyle(TextInputStyle.Short)
            .setValue(authorNumber.toString())
            .setRequired(true)

        const orderLabel = new LabelBuilder()
            .setLabel('Author ordinal:')
            .setTextInputComponent(orderInput);


        modal.addLabelComponents(
            userIDLabel,
            urlLabel,
            reasonLabel,
            shouldDisplayLabel,
            orderLabel
        );

        return modal
    }

    async execute(guildHolder: GuildHolder, interaction: ModalSubmitInteraction, key: string): Promise<void> {
        const submissionId = interaction.channelId
        if (!submissionId) {
            replyEphemeral(interaction, 'Submission ID not found')
            return
        }

        const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId)
        if (!submission) {
            replyEphemeral(interaction, 'Submission not found')
            return
        }

        if (
            !canEditSubmission(interaction, submission)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this!')
            return;
        }

        const isFirstTime = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) === null;
        let authors = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) ?? await submission.getPotentialAuthorsFromMessageContent() ?? [];
        const existingAuthorIndex = authors.findIndex(a => getAuthorKey(a).substring(0, 50) === key);
        const existingAuthor = existingAuthorIndex !== -1 ? authors[existingAuthorIndex] : null;
        if (key.length && !existingAuthor) {
            replyEphemeral(interaction, 'Author not found');
            return;
        }

        const userId = interaction.fields.getTextInputValue('idInput') || null;
        const reason = interaction.fields.getTextInputValue('reasonInput') || undefined;
        const shouldDisplay = interaction.fields.getStringSelectValues('shouldDisplay')[0] === 'yes';
        const url = interaction.fields.getTextInputValue('urlInput') || undefined;
        const orderValue = parseInt(interaction.fields.getTextInputValue('orderInput')) || 0;

        if (!userId) {
            replyEphemeral(interaction, 'Please provide either a Discord User ID or a name.');
            return;
        }

        let newAuthor: Author;


        const isUserIDSnowflake = userId && /^\d{17,19}$/.test(userId);
        if (isUserIDSnowflake) {
            // fetch user
            const user = await getDiscordAuthorsFromIDs(guildHolder, [userId]);
            if (user.length === 0) {
                replyEphemeral(interaction, 'User not found. Please provide a valid Discord User ID.');
                return;
            }
            newAuthor = user[0];
        } else {
            newAuthor = {
                type: AuthorType.Unknown,
                username: userId,
            };
        }

        if (!shouldDisplay) {
            newAuthor.dontDisplay = true; // If the user doesn't want to display this author, we set dontDisplay to true
        }

        if (reason) {
            newAuthor.reason = reason;
        }

        if (url) {
            // check if the URL is valid
            try {
                new URL(url); // This will throw if the URL is invalid
            } catch (e) {
                replyEphemeral(interaction, 'Invalid URL format. Please provide a valid URL or leave it empty.');
                return;
            }
            newAuthor.url = url; // If a URL is provided, we add it to the author object
        }

        if (authors.some((a, i) => {
            return areAuthorsSame(a, newAuthor) && i !== existingAuthorIndex; // We allow the author to be the same as the one we're editing, but not the same as any other author
        })) {
            replyEphemeral(interaction, 'This author is already added to the submission separately. Please edit the existing entry instead of creating a duplicate.');
            return;
        }

        if (existingAuthor) {
            newAuthor = {
                ...existingAuthor,
                ...newAuthor,
            }

            // remove old author from the list
            authors.splice(existingAuthorIndex, 1);
        }

        // insert the new/edited author into the list based on the provided order
        let newIndex: number;
        if (orderValue <= 1) {
            authors.unshift(newAuthor);
            newIndex = 0;
        } else if (orderValue > authors.length) {
            authors.push(newAuthor);
            newIndex = authors.length - 1;
        } else {
            authors.splice(orderValue - 1, 0, newAuthor);
            newIndex = orderValue - 1;
        }

        await interaction.deferUpdate();

        authors = await reclassifyAuthors(guildHolder, authors);

        submission.getConfigManager().setConfig(SubmissionConfigs.AUTHORS, authors);

        const channel = await submission.getSubmissionChannel();
        if (!channel) {
            replyEphemeral(interaction, 'Submission channel not found. Please try again later.');
            return;
        }
        // channel.send({
        //     content: `<@${interaction.user.id}> edited author: ${getAuthorsString([newAuthor])}${newAuthor.reason ? ` with reason: ${newAuthor.reason}` : ''}`,
        //     flags: MessageFlags.SuppressNotifications
        // });

        // make changelog

        if (existingAuthor) {
            const changes = [];
            if (existingAuthorIndex !== newIndex) {
                changes.push(`Order: ${existingAuthorIndex + 1} -> ${newIndex + 1}`);
            }
            if (existingAuthor.type !== newAuthor.type) {
                changes.push(`Type: ${existingAuthor.type} -> ${newAuthor.type}`);
            }
            if (getAuthorName(existingAuthor) !== getAuthorName(newAuthor)) {
                changes.push(`Name: ${getAuthorName(existingAuthor)} -> ${getAuthorName(newAuthor)}`);
            }
            if (existingAuthor.url !== newAuthor.url) {
                changes.push(`URL: ${existingAuthor.url || 'none'} -> ${newAuthor.url || 'none'}`);
            }
            if (existingAuthor.reason !== newAuthor.reason) {
                changes.push(`Reason: ${existingAuthor.reason || 'none'} -> ${newAuthor.reason || 'none'}`);
            }
            if (existingAuthor.dontDisplay !== newAuthor.dontDisplay) {
                changes.push(`Display on by line: ${existingAuthor.dontDisplay ? 'no' : 'yes'} -> ${newAuthor.dontDisplay ? 'no' : 'yes'}`);
            }

            channel.send({
                content: truncateStringWithEllipsis(`<@${interaction.user.id}> edited author: ${getAuthorsString([newAuthor])}\nChanges:\n${changes.join('\n')}`, 2000),
                flags: MessageFlags.SuppressNotifications,
                allowedMentions: { parse: [] },
            });

            if (interaction.isFromMessage()) {
                await new EditAuthorsButton().sendAuthorEditButtons(submission, interaction);
            }
        } else {
            channel.send({
                content: `<@${interaction.user.id}> added author: ${getAuthorsString([newAuthor])}${newAuthor.reason ? ` with reason: ${newAuthor.reason}` : ''}`,
                flags: MessageFlags.SuppressNotifications,
            });
            await SetAuthorsMenu.sendAuthorsMenuAndButton(submission, interaction, true);
        }

        await submission.statusUpdated();

        if (isFirstTime) {
            await SetArchiveCategoryMenu.sendArchiveCategorySelector(submission, interaction);
        }

        await submission.onAuthorsUpdated();
    }
}