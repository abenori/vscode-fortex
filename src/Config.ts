import * as vscode from 'vscode';

export default class Config {
  static readonly config_name = "vscode-fortex";
  static get<T>(key: string, default_value: T) : T {
    return vscode.workspace.getConfiguration(Config.config_name).get<T>(key, default_value);
  }

  public static mainFileOrder(){
    return Config.get<string[]>("mainFileOrder", ["magick", "guess", "current"]);
  }

  public static compileTrigger(){
    return Config.get<string[]>("compileTrigger", ["onSave"]);
  }

}
