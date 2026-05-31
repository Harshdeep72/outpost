import type { ChatInputCommandInteraction } from "discord.js";
import { makeEmbed, hasAdminRole, smokyFooterText } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

const SHARE_LINK_RE = /reddit\.com\/r\/[^/]+\/s\/[A-Za-z0-9]+/i;

export async function handleTestUrlCommand(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Could not verify your roles.")],
      flags: 64,
    });
  }
  if (!hasAdminRole(member as any, interaction.guild!)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This command is admin/mod only.")],
      flags: 64,
    });
  }

  const rawUrl = interaction.options.getString("url", true).trim();
  const redditUsername = interaction.options.getString("reddit_username")?.trim() ?? "";

  await interaction.deferReply({ flags: 64 });

  const start = Date.now();

  try {
    const { parseRedditProofUrl, resolveShareLink, validateRedditProof } = await import("../reddit-validator.js");

    // ── Resolve Reddit share links (reddit.com/r/sub/s/XXXX) ─────────────────
    let proofUrl = rawUrl;
    let resolvedFrom: string | null = null;
    if (SHARE_LINK_RE.test(rawUrl)) {
      const resolved = await resolveShareLink(rawUrl);
      if (!resolved) {
        return interaction.editReply({
          embeds: [
            makeEmbed(COLORS.DANGER)
              .setTitle("🔗 Test URL — Share Link Failed")
              .setDescription(
                `Could not resolve the Reddit share link:\n\`${rawUrl}\`\n\n` +
                `Reddit may have rejected the redirect request. Try pasting the full comment URL instead.`
              ),
          ],
        });
      }
      resolvedFrom = rawUrl;
      proofUrl = resolved;
    }

    // ── Parse the (possibly resolved) URL ────────────────────────────────────
    const parsed = parseRedditProofUrl(proofUrl);

    if (!parsed) {
      return interaction.editReply({
        embeds: [
          makeEmbed(COLORS.DANGER)
            .setTitle("🔗 Test URL — Invalid")
            .setDescription(
              `Could not parse \`${proofUrl}\` as a Reddit proof URL.\n\n` +
              `Expected formats:\n` +
              `• \`reddit.com/r/sub/comments/postId\`\n` +
              `• \`reddit.com/r/sub/comments/postId/comment/commentId\`\n` +
              `• \`reddit.com/r/sub/s/ShareCode\` (share link — auto-resolved)`
            ),
        ],
      });
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    // validateRedditProof handles both comments and posts internally.
    const result = await validateRedditProof(
      proofUrl,
      redditUsername ? [redditUsername] : [],
      ""
    );

    const elapsed = Date.now() - start;

    const passed: boolean = result.passed;
    const color = passed ? COLORS.SUCCESS : result.status === "api_unreachable" ? COLORS.WARNING : COLORS.DANGER;
    const statusLine = `${result.statusEmoji ?? (passed ? "✅" : "❌")} **${result.statusLabel ?? result.status}**`;

    const fields: { name: string; value: string; inline?: boolean }[] = [];

    if (resolvedFrom) {
      fields.push({ name: "🔗 Share Link", value: `\`${resolvedFrom}\``, inline: false });
      fields.push({ name: "🔗 Resolved URL", value: `\`${proofUrl}\``, inline: false });
    } else {
      fields.push({ name: "🔗 URL", value: `\`${proofUrl}\``, inline: false });
    }

    fields.push(
      { name: "📊 Result", value: statusLine, inline: true },
      { name: "⏱️ Time", value: `${elapsed}ms`, inline: true },
      { name: "📂 Type", value: parsed.commentId ? "Comment" : "Post", inline: true },
    );

    if (parsed.subreddit) {
      fields.push({ name: "📌 Subreddit (URL)", value: `r/${parsed.subreddit}`, inline: true });
    }
    if (result.subredditFound) {
      fields.push({ name: "📌 Subreddit (found)", value: `r/${result.subredditFound}`, inline: true });
    }
    if (result.authorFound) {
      fields.push({ name: "👤 Author", value: `u/${result.authorFound}`, inline: true });
    }
    if (result.verifiedVia) {
      const viaLabel: Record<string, string> = {
        oauth: "OAuth API",
        json_proxy: "Proxy JSON",
        rss: "RSS feed",
        html: "old.reddit HTML",
      };
      fields.push({ name: "🔍 Verified via", value: viaLabel[result.verifiedVia] ?? result.verifiedVia, inline: true });
    }
    if (result.createdAt) {
      fields.push({ name: "📅 Comment date", value: result.createdAt, inline: true });
    }
    if (result.postLive !== undefined) {
      fields.push({ name: "📄 Post live?", value: result.postLive ? "Yes" : "No", inline: true });
    }
    if (result.bodyText) {
      const bodyPreview = result.bodyText.replace(/[\r\n]+/g, " ").slice(0, 200);
      fields.push({ name: "💬 Body (first 200 chars)", value: `\`${bodyPreview}\``, inline: false });
    }

    const failureText = result.failures?.length
      ? result.failures.map((f: string) => `• ${f}`).join("\n")
      : null;
    if (failureText) {
      fields.push({ name: "⚠️ Failures", value: failureText.slice(0, 1024), inline: false });
    }

    const titleSuffix = passed ? "Passed" : result.status === "api_unreachable" ? "Inconclusive" : "Failed";
    const embed = makeEmbed(color)
      .setTitle(`🧪 Test URL — ${titleSuffix}`)
      .addFields(fields)
      .setFooter({ text: smokyFooterText(`Checked ${new Date().toUTCString()}`) });

    logger.info({ rawUrl, proofUrl, status: result.status, elapsed }, "testurl command result");

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error({ err, rawUrl }, "testurl command threw");
    const elapsed = Date.now() - start;
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("🧪 Test URL — Error")
          .addFields(
            { name: "🔗 URL", value: `\`${rawUrl}\`` },
            { name: "❌ Error", value: String(err) },
            { name: "⏱️ Time", value: `${elapsed}ms`, inline: true },
          ),
      ],
    });
  }
}
