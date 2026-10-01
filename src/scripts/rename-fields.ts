import sequelize from "../configs/DB/sequelize";
import Note from "../models/Note";

const renames: Record<string, string> = {
  "Platform/Website": "Platform",
  "Service Name": "Platform",
  Service: "Platform",
  "Key/Password": "Key/Pass",
  "2FA/Security": "2FA",
};

async function main() {
  await sequelize.authenticate();
  const notes = await Note.findAll({ paranoid: false });
  let updated = 0;

  for (const note of notes) {
    const content = note.content as {
      customFields?: { label: string; value: string }[];
    };
    if (!content?.customFields?.length) continue;

    let changed = false;
    const customFields = content.customFields.map((field) => {
      if (field.label === "Username/Email") {
        changed = true;
        const value = String(field.value ?? "");
        return {
          ...field,
          label: value.includes("@") ? "Email" : "Username",
        };
      }
      const next = renames[field.label];
      if (!next || next === field.label) return field;
      changed = true;
      return { ...field, label: next };
    });

    if (!changed) continue;
    note.set("content", { ...content, customFields });
    note.changed("content", true);
    await note.save();
    updated += 1;
  }

  console.log(`Updated ${updated} notes`);
  await sequelize.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
