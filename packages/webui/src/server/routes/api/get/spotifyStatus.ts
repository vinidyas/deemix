import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/spotifyStatus";

const handler: ApiHandler["handler"] = (req, res) => {
	const deemix = req.app.get("deemix");
	res.send({
		spotifyEnabled: deemix.plugins.spotify.enabled,
		spotifyUser: deemix.plugins.spotify.getUser(),
	});
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
