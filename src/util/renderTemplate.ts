const ejs = require("ejs");

export const renderTemplate = (template: any, variables: any) => {
  return ejs.render(template, variables);
};
