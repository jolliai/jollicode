const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://jolli.ai" : `https://${stage}.jolli.ai`,
  console: stage === "production" ? "https://jolli.ai/auth" : `https://${stage}.jolli.ai/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/jolliai/jollicode",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
