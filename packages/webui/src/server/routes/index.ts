import express, { Router } from "express";

const router: Router = express.Router();

router.get("/spotify/callback", async (req, res) => {
	const deemix = req.app.get("deemix");
	const { code, error, state } = req.query;

	if (error) {
		res.redirect(`/settings?spotify=error`);
		return;
	}

	const spotifyPlugin = deemix.plugins.spotify;
	const redirectUri =
		typeof state === "string"
			? spotifyPlugin.consumeAuthorizationState(state)
			: null;
	if (typeof code !== "string" || typeof state !== "string" || !redirectUri) {
		res.redirect(`/settings?spotify=error`);
		return;
	}

	try {
		await spotifyPlugin.completeAuthorization(code, redirectUri);
		res.redirect(`/settings?spotify=connected`);
	} catch {
		res.redirect(`/settings?spotify=error`);
	}
});

export default router;
