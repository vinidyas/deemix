import { type ApiHandler } from "@/types.js";

const path: ApiHandler["path"] = "/spotifyConnect";

const handler: ApiHandler["handler"] = (req, res) => {
	const deemix = req.app.get("deemix");
	const port = req.app.get("port");
	const { clientId, clientSecret, fallbackSearch } = req.body ?? {};
	let { redirectUri } = req.body ?? {};

	if (!clientId || !clientSecret) {
		res.status(400).send({ error: "missingSpotifyCredentials" });
		return;
	}

	const spotifyPlugin = deemix.plugins.spotify;
	redirectUri = redirectUri || spotifyPlugin.getRedirectUri(port);
	let redirectUrl: URL;
	try {
		redirectUrl = new URL(redirectUri);
	} catch {
		res.status(400).send({ error: "invalidSpotifyRedirectUri" });
		return;
	}

	const isLocalHttp =
		redirectUrl.protocol === "http:" && redirectUrl.hostname === "127.0.0.1";
	const isHttps = redirectUrl.protocol === "https:";

	if (
		(!isLocalHttp && !isHttps) ||
		redirectUrl.pathname !== "/spotify/callback"
	) {
		res.status(400).send({ error: "invalidSpotifyRedirectUri" });
		return;
	}

	spotifyPlugin.saveSettings({
		clientId,
		clientSecret,
		redirectUri,
		fallbackSearch: !!fallbackSearch,
	});

	const state = spotifyPlugin.createAuthorizationState(redirectUri);

	res.send({
		authUrl: spotifyPlugin.getAuthorizationUrl(redirectUri, state),
		redirectUri,
	});
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
