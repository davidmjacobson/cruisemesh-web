const CANONICAL_ORIGIN = "https://cruisemesh.app";

export default {
  fetch(request) {
    const incoming = new URL(request.url);
    const destination = new URL(`${incoming.pathname}${incoming.search}`, CANONICAL_ORIGIN);

    return new Response(null, {
      status: 308,
      headers: { Location: destination.toString() },
    });
  },
};
