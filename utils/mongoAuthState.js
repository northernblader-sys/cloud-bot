// WhatsApp auth state stored in MongoDB instead of the auth_info/ folder.
// Same contract as Baileys' useMultiFileAuthState: returns { state, saveCreds }.
//
// Each signal key / the creds blob is one document:
//   { _id: "<type>-<id>", json: "<JSON string>" }
// Values are stored as a JSON *string* (with Baileys' BufferJSON) so Buffers
// survive and Mongo's field-name rules ("." and "$") never get in the way.
const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");
const mongo = require("./mongo");

async function useMongoAuthState() {
  const col = mongo.getCollection("auth");

  const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
  const decode = (json) => JSON.parse(json, BufferJSON.reviver);

  const read = async (id) => {
    const doc = await col.findOne({ _id: id });
    return doc ? decode(doc.json) : null;
  };

  const creds = (await read("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!ids.length) return data;
          const docs = await col.find({ _id: { $in: ids.map((id) => `${type}-${id}`) } }).toArray();
          const found = new Map(docs.map((d) => [d._id, d.json]));
          for (const id of ids) {
            const json = found.get(`${type}-${id}`);
            let value = json ? decode(json) : null;
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const ops = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const _id = `${category}-${id}`;
              ops.push(
                value
                  ? { replaceOne: { filter: { _id }, replacement: { _id, json: encode(value) }, upsert: true } }
                  : { deleteOne: { filter: { _id } } }
              );
            }
          }
          if (ops.length) await col.bulkWrite(ops, { ordered: false });
        },
      },
    },
    saveCreds: async () => {
      await col.replaceOne({ _id: "creds" }, { _id: "creds", json: encode(creds) }, { upsert: true });
    },
  };
}

module.exports = { useMongoAuthState };
